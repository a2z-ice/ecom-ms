"""seed initial inventory

Revision ID: 002
Revises: 001
Create Date: 2026-02-25

NOTE: book_id values must match the UUIDs seeded into the ecom-service books table.
In production, inventory is seeded via an admin API or bootstrap job, not migration.
This seed uses fixed UUIDs for local development convenience only.
"""
from alembic import op
import sqlalchemy as sa

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None

# 10 placeholder entries (quantity=50 each); book_ids are placeholders.
# Replace with real UUIDs after ecom-service seeds its books table.
SEED_DATA = [
    {"book_id": "00000000-0000-0000-0000-000000000001", "quantity": 50},
    {"book_id": "00000000-0000-0000-0000-000000000002", "quantity": 50},
    {"book_id": "00000000-0000-0000-0000-000000000003", "quantity": 50},
    {"book_id": "00000000-0000-0000-0000-000000000004", "quantity": 50},
    {"book_id": "00000000-0000-0000-0000-000000000005", "quantity": 50},
    {"book_id": "00000000-0000-0000-0000-000000000006", "quantity": 50},
    {"book_id": "00000000-0000-0000-0000-000000000007", "quantity": 50},
    {"book_id": "00000000-0000-0000-0000-000000000008", "quantity": 50},
    {"book_id": "00000000-0000-0000-0000-000000000009", "quantity": 50},
    {"book_id": "00000000-0000-0000-0000-000000000010", "quantity": 50},
]


def upgrade() -> None:
    inventory = sa.table(
        "inventory",
        sa.column("book_id", sa.UUID()),
        sa.column("quantity", sa.Integer()),
        sa.column("reserved", sa.Integer()),
    )
    op.bulk_insert(inventory, [{"reserved": 0, **row} for row in SEED_DATA])


def downgrade() -> None:
    op.execute("DELETE FROM inventory")
