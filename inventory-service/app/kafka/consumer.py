"""Kafka consumer — listens to order.created, deducts stock, publishes inventory.updated."""
import json
import logging
from datetime import datetime, timezone
from uuid import UUID

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from sqlalchemy import select

from app.config import settings
from app.database import AsyncSessionLocal
from app.models.inventory import Inventory

logger = logging.getLogger(__name__)


async def _deduct_stock(order_event: dict) -> None:
    order_id = order_event.get("orderId")
    items = order_event.get("items", [])

    async with AsyncSessionLocal() as session:
        for item in items:
            book_id = UUID(item["bookId"])
            quantity = item["quantity"]

            result = await session.execute(
                select(Inventory).where(Inventory.book_id == book_id).with_for_update()
            )
            inv = result.scalar_one_or_none()

            if inv is None:
                logger.warning("Inventory record not found for book_id=%s — skipping", book_id)
                continue

            if inv.available < quantity:
                logger.warning(
                    "Insufficient stock for book_id=%s (available=%d requested=%d)",
                    book_id, inv.available, quantity,
                )
                continue

            prev_qty = inv.quantity
            inv.quantity -= quantity
            await session.flush()

            yield {
                "bookId": str(book_id),
                "previousQuantity": prev_qty,
                "newQuantity": inv.quantity,
                "orderId": order_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

        await session.commit()


async def run_consumer() -> None:
    consumer = AIOKafkaConsumer(
        "order.created",
        bootstrap_servers=settings.kafka_bootstrap_servers,
        group_id=settings.kafka_group_id,
        value_deserializer=lambda m: json.loads(m.decode("utf-8")),
        auto_offset_reset="earliest",
        enable_auto_commit=False,
    )
    producer = AIOKafkaProducer(
        bootstrap_servers=settings.kafka_bootstrap_servers,
        value_serializer=lambda v: json.dumps(v).encode("utf-8"),
    )

    await consumer.start()
    await producer.start()
    logger.info("Inventory Kafka consumer started.")

    try:
        async for msg in consumer:
            order_event = msg.value
            logger.info("Received order.created event: orderId=%s", order_event.get("orderId"))

            async for inv_event in _deduct_stock(order_event):
                await producer.send_and_wait("inventory.updated", value=inv_event)
                logger.info("Published inventory.updated: bookId=%s", inv_event["bookId"])

            await consumer.commit()
    except Exception as exc:
        logger.error("Consumer error: %s", exc, exc_info=True)
        raise
    finally:
        await consumer.stop()
        await producer.stop()
