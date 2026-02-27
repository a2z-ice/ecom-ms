"""
Analytics CDC Consumer
Reads Debezium CDC events (schemaless JSON) from Kafka and upserts into analytics DB.
"""
import json
import logging
import os
import time

import psycopg2
from kafka import KafkaConsumer
from kafka.errors import NoBrokersAvailable

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

KAFKA_BOOTSTRAP = os.environ["KAFKA_BOOTSTRAP_SERVERS"]
DATABASE_URL = os.environ["DATABASE_URL"]

# Maps CDC topic → (analytics table, pk_column, columns_to_write)
TOPIC_CONFIG = {
    "ecom-connector.public.orders": (
        "fact_orders",
        "id",
        ["id", "user_id", "total", "status", "created_at"],
    ),
    "ecom-connector.public.order_items": (
        "fact_order_items",
        "id",
        ["id", "order_id", "book_id", "quantity", "price_at_purchase"],
    ),
    "ecom-connector.public.books": (
        "dim_books",
        "id",
        ["id", "title", "author", "price", "description", "cover_url",
         "isbn", "genre", "published_year", "created_at"],
    ),
    "inventory-connector.public.inventory": (
        "fact_inventory",
        "book_id",
        ["book_id", "quantity", "reserved", "updated_at"],
    ),
}


def connect_db() -> psycopg2.extensions.connection:
    while True:
        try:
            conn = psycopg2.connect(DATABASE_URL)
            conn.autocommit = False
            logger.info("Connected to analytics DB")
            return conn
        except Exception as exc:
            logger.error("DB connect failed: %s — retrying in 5s", exc)
            time.sleep(5)


def connect_kafka() -> KafkaConsumer:
    topics = list(TOPIC_CONFIG.keys())
    while True:
        try:
            consumer = KafkaConsumer(
                *topics,
                bootstrap_servers=KAFKA_BOOTSTRAP,
                group_id="analytics-cdc-consumer",
                auto_offset_reset="earliest",
                enable_auto_commit=True,
                value_deserializer=lambda v: json.loads(v.decode("utf-8")),
                key_deserializer=lambda k: json.loads(k.decode("utf-8")) if k else None,
                consumer_timeout_ms=-1,
            )
            logger.info("Connected to Kafka, subscribed to %s", topics)
            return consumer
        except NoBrokersAvailable:
            logger.error("Kafka not available — retrying in 5s")
            time.sleep(5)
        except Exception as exc:
            logger.error("Kafka connect failed: %s — retrying in 5s", exc)
            time.sleep(5)


def upsert(conn: psycopg2.extensions.connection, table: str, pk_col: str,
           cols: list[str], row: dict) -> None:
    values = [row.get(c) for c in cols]
    col_list = ", ".join(cols)
    placeholders = ", ".join(["%s"] * len(cols))
    update_set = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols if c != pk_col)
    sql = (
        f"INSERT INTO {table} ({col_list}) VALUES ({placeholders}) "
        f"ON CONFLICT ({pk_col}) DO UPDATE SET {update_set}"
    )
    with conn.cursor() as cur:
        cur.execute(sql, values)
    conn.commit()


def main() -> None:
    logger.info("Analytics CDC consumer starting")
    conn = connect_db()
    consumer = connect_kafka()

    for message in consumer:
        topic = message.topic
        if topic not in TOPIC_CONFIG:
            continue

        table, pk_col, cols = TOPIC_CONFIG[topic]
        value = message.value

        if not isinstance(value, dict):
            continue

        # Debezium envelope has 'after' field; flat records don't
        if "after" in value:
            after = value["after"]
            op = value.get("op", "r")
            if after is None or op == "d":
                # DELETE — skip for analytics (no deletes in data warehouse)
                continue
        else:
            after = value

        try:
            upsert(conn, table, pk_col, cols, after)
            logger.debug("Upserted %s pk=%s", table, after.get(pk_col))
        except Exception as exc:
            logger.error("Upsert failed for %s: %s", table, exc)
            conn.rollback()
            try:
                conn.close()
            except Exception:
                pass
            conn = connect_db()


if __name__ == "__main__":
    main()
