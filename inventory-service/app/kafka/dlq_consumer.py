"""DLQ consumer — monitors order.created.dlq for failed messages and exposes them via admin API."""
import asyncio
import json
import logging
from collections import deque
from datetime import datetime, timezone

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

from app.config import settings

logger = logging.getLogger(__name__)

_BACKOFF_INITIAL = 5.0
_BACKOFF_MAX = 60.0
_BACKOFF_FACTOR = 2.0
_DLQ_TOPIC = "order.created.dlq"
_SOURCE_TOPIC = "order.created"
_MAX_STORED = 100


class DlqMonitor:
    """Stores last N DLQ messages in-memory for admin inspection and supports retry."""

    def __init__(self):
        self._messages: deque[dict] = deque(maxlen=_MAX_STORED)
        self._total_count: int = 0

    @property
    def total_count(self) -> int:
        return self._total_count

    @property
    def messages(self) -> list[dict]:
        return list(self._messages)

    def add(self, msg: dict) -> None:
        self._total_count += 1
        self._messages.append(msg)

    def get_by_id(self, msg_id: int) -> dict | None:
        for m in self._messages:
            if m.get("id") == msg_id:
                return m
        return None


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
                "id": dlq_monitor.total_count + 1,
                "offset": msg.offset,
                "partition": msg.partition,
                "timestamp": datetime.fromtimestamp(
                    msg.timestamp / 1000, tz=timezone.utc
                ).isoformat(),
                "receivedAt": datetime.now(timezone.utc).isoformat(),
                "event": msg.value,
            }
            dlq_monitor.add(dlq_entry)
            try:
                await consumer.commit()
            except Exception as exc:
                logger.error("Failed to commit DLQ offset: %s — may be reprocessed on restart", exc)
            logger.warning(
                "DLQ message #%d received: orderId=%s",
                dlq_entry["id"],
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
    entry = dlq_monitor.get_by_id(msg_id)
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
        logger.info("Retried DLQ message #%d back to '%s'", msg_id, _SOURCE_TOPIC)
        return {"status": "retried", "id": msg_id, "topic": _SOURCE_TOPIC}
    finally:
        await producer.stop()
