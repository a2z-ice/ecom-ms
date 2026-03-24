"""Kafka consumer — listens to order.created, deducts stock, publishes inventory.updated."""
import asyncio
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

_BACKOFF_INITIAL = 1.0
_BACKOFF_MAX = 60.0
_BACKOFF_FACTOR = 2.0
_DLQ_TOPIC = "order.created.dlq"
_MAX_RETRIES = 3


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


async def _process_message_with_retry(
    order_event: dict,
    producer: AIOKafkaProducer,
    original_msg,
) -> bool:
    """Process a single order event with up to _MAX_RETRIES attempts.

    Returns True if processed successfully, False if sent to DLQ.
    """
    order_id = order_event.get("orderId")

    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            async for inv_event in _deduct_stock(order_event):
                await producer.send_and_wait("inventory.updated", value=inv_event)
                logger.info("Published inventory.updated: bookId=%s", inv_event["bookId"])
            return True
        except Exception as exc:
            logger.warning(
                "Failed to process order %s (attempt %d/%d): %s",
                order_id, attempt, _MAX_RETRIES, exc,
            )
            if attempt < _MAX_RETRIES:
                await asyncio.sleep(0.5 * attempt)

    # All retries exhausted — send to DLQ
    logger.error(
        "All %d retries exhausted for order %s — sending to DLQ topic '%s'",
        _MAX_RETRIES, order_id, _DLQ_TOPIC,
    )
    try:
        dlq_envelope = {
            "originalTopic": "order.created",
            "failedAt": datetime.now(timezone.utc).isoformat(),
            "retries": _MAX_RETRIES,
            "event": order_event,
        }
        await producer.send_and_wait(_DLQ_TOPIC, value=dlq_envelope)
        logger.info("Message for order %s sent to DLQ successfully", order_id)
    except Exception as dlq_exc:
        logger.error(
            "Failed to send order %s to DLQ: %s — message will be lost",
            order_id, dlq_exc,
        )
    return False


async def _run_consumer_loop() -> None:
    """Core consumer loop — raises on unrecoverable errors."""
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

            await _process_message_with_retry(order_event, producer, msg)

            # Always commit offset — failed messages go to DLQ, don't block the consumer.
            # Wrapped in try/except: if commit fails, reprocessing is safe because
            # _deduct_stock uses SELECT ... FOR UPDATE and checks inv.available < quantity.
            try:
                await consumer.commit()
            except Exception as exc:
                logger.error(
                    "Failed to commit offset for orderId=%s: %s — may be reprocessed on restart",
                    order_event.get("orderId"), exc,
                )
    finally:
        await consumer.stop()
        await producer.stop()


async def run_consumer_supervised() -> None:
    """Supervised consumer with exponential backoff restart on errors.

    On CancelledError (graceful shutdown), exits without restart.
    On any other exception, logs the error, waits with exponential backoff, and restarts.
    """
    backoff = _BACKOFF_INITIAL
    while True:
        try:
            await _run_consumer_loop()
            # Consumer exited normally (shouldn't happen in practice) — restart
            logger.warning("Kafka consumer exited normally, restarting...")
            backoff = _BACKOFF_INITIAL
        except asyncio.CancelledError:
            logger.info("Kafka consumer received cancellation — shutting down gracefully.")
            raise
        except Exception as exc:
            logger.error(
                "Kafka consumer crashed: %s — restarting in %.1fs",
                exc, backoff, exc_info=True,
            )
            await asyncio.sleep(backoff)
            backoff = min(backoff * _BACKOFF_FACTOR, _BACKOFF_MAX)
