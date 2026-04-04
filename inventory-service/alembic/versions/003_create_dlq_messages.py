"""create dlq_messages table for persistent DLQ storage

Revision ID: 003
Revises: 002
Create Date: 2026-03-29
"""
from alembic import op
import sqlalchemy as sa

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "dlq_messages",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("offset", sa.Integer, nullable=False),
        sa.Column("partition", sa.Integer, nullable=False, server_default="0"),
        sa.Column("kafka_timestamp", sa.String(50), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("event_payload", sa.Text, nullable=False),
        sa.Column("retried_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("retry_count", sa.Integer, nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_table("dlq_messages")
