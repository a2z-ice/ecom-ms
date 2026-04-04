from datetime import datetime, timezone

from sqlalchemy import Integer, DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.inventory import Base


class DLQMessage(Base):
    """Persisted Dead Letter Queue message for failed order processing."""

    __tablename__ = "dlq_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    offset: Mapped[int] = mapped_column(Integer, nullable=False)
    partition: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    kafka_timestamp: Mapped[str] = mapped_column(String(50), nullable=True)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    event_payload: Mapped[str] = mapped_column(Text, nullable=False)
    retried_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
