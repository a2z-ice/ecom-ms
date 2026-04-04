"""DLQ consumer — monitors order.created.dlq for failed messages, persists to DB, exposes via admin API."""
import asyncio
import json
import logging
from datetime import datetime, timezone

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from sqlalchemy import select, func

from app.config import settings
from app.database import AsyncSessionLocal
from app.models.dlq_message import DLQMessage

logger = logging.getLogger(__name__)

_BACKOFF_INITIAL = 5.0
_BACKOFF_MAX = 60.0
_BACKOFF_FACTOR = 2.0
_DLQ_TOPIC = "order.created.dlq"
_SOURCE_TOPIC = "order.created"


class DlqMonitor:
    """Persists DLQ messages to database for admin inspection and retry."""

    @property
    async def total_count(self) -> int:
        async with AsyncSessionLocal() as session:
            result = await session.execute(select(func.count(DLQMessage.id)))
            return result.scalar_one()

    async def messages(self, limit: int = 100) -> list[dict]:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(DLQMessage).order_by(DLQMessage.id.desc()).limit(limit)
            )
            return [
                {
                    "id": m.id,
                    "offset": m.offset,
                    "partition": m.partition,
                    "timestamp": m.kafka_timestamp,
                    "receivedAt": m.received_at.isoformat() if m.received_at else None,
                    "event": json.loads(m.event_payload),
                    "retriedAt": m.retried_at.isoformat() if m.retried_at else None,
                    "retryCount": m.retry_count,
                }
                for m in result.scalars().all()
            ]

    async def add(self, msg_data: dict) -> None:
        async with AsyncSessionLocal() as session:
            dlq_msg = DLQMessage(
                offset=msg_data["offset"],
                partition=msg_data["partition"],
                kafka_timestamp=msg_data.get("timestamp"),
                event_payload=json.dumps(msg_data["event"]),
            )
            session.add(dlq_msg)
            await session.commit()

    async def get_by_id(self, msg_id: int) -> dict | None:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(DLQMessage).where(DLQMessage.id == msg_id)
            )
            m = result.scalar_one_or_none()
            if m is None:
                return None
            return {
                "id": m.id,
                "offset": m.offset,
                "partition": m.partition,
                "timestamp": m.kafka_timestamp,
                "receivedAt": m.received_at.isoformat() if m.received_at else None,
                "event": json.loads(m.event_payload),
                "retriedAt": m.retried_at.isoformat() if m.retried_at else None,
                "retryCount": m.retry_count,
            }


# Singleton instance — shared with admin API
dlq_monitor = DlqMonitor()


async def _run_dlq_consumer_loop() -> None:
    """Core DLQ consumer loop."""
    consumer = AIOKafkaConsumer(
        _DLQ_TOPIC,
        bootstrap_servers=settings.kafka_bootstrap_servers,
        group_id="inventory-dlq-monitor",
        value_deserializer=lambda m: json.loads(m.decode("utf-8")),
        auto_offset_reset="earliest",
        enable_auto_commit=False,
    )
    await consumer.start()
    logger.info("DLQ consumer started on topic '%s'", _DLQ_TOPIC)

    try:
        async for msg in consumer:
            dlq_entry = {
                "offset": msg.offset,
                "partition": msg.partition,
                "timestamp": datetime.fromtimestamp(
                    msg.timestamp / 1000, tz=timezone.utc
                ).isoformat(),
                "event": msg.value,
            }
            await dlq_monitor.add(dlq_entry)
            try:
                await consumer.commit()
            except Exception as exc:
                logger.error("Failed to commit DLQ offset: %s — may be reprocessed on restart", exc)
            logger.warning(
                "DLQ message received: orderId=%s",
                msg.value.get("event", {}).get("orderId", "unknown"),
            )
    finally:
        await consumer.stop()


async def run_dlq_consumer_supervised() -> None:
    """Supervised DLQ consumer with exponential backoff on errors."""
    backoff = _BACKOFF_INITIAL
    while True:
        try:
            await _run_dlq_consumer_loop()
            backoff = _BACKOFF_INITIAL
        except asyncio.CancelledError:
            logger.info("DLQ consumer shutting down gracefully.")
            raise
        except Exception as exc:
            logger.error("DLQ consumer crashed: %s — restarting in %.1fs", exc, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * _BACKOFF_FACTOR, _BACKOFF_MAX)


async def retry_dlq_message(msg_id: int) -> dict | None:
    """Re-publish a DLQ message back to the source topic for reprocessing."""
    entry = await dlq_monitor.get_by_id(msg_id)
    if entry is None:
        return None

    original_event = entry.get("event", {}).get("event")
    if original_event is None:
        return {"error": "No original event found in DLQ envelope"}

    producer = AIOKafkaProducer(
        bootstrap_servers=settings.kafka_bootstrap_servers,
        value_serializer=lambda v: json.dumps(v).encode("utf-8"),
    )
    await producer.start()
    try:
        await producer.send_and_wait(_SOURCE_TOPIC, value=original_event)
        # Update retry tracking in DB
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(DLQMessage).where(DLQMessage.id == msg_id)
            )
            dlq_msg = result.scalar_one_or_none()
            if dlq_msg:
                dlq_msg.retried_at = datetime.now(timezone.utc)
                dlq_msg.retry_count += 1
                await session.commit()
        logger.info("Retried DLQ message #%d back to '%s'", msg_id, _SOURCE_TOPIC)
        return {"status": "retried", "id": msg_id, "topic": _SOURCE_TOPIC}
    finally:
        await producer.stop()
