"""Shared fixtures for inventory-service unit tests."""
import os
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

# Set environment variables BEFORE importing anything from app.*
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/test")
os.environ.setdefault("KEYCLOAK_JWKS_URI", "http://localhost:8080/realms/test/protocol/openid-connect/certs")
os.environ.setdefault("KEYCLOAK_ISSUER_URI", "http://localhost:8080/realms/test")
os.environ.setdefault("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")

from app.models.inventory import Inventory


BOOK_ID_1 = UUID("00000000-0000-0000-0000-000000000001")
BOOK_ID_2 = UUID("00000000-0000-0000-0000-000000000002")
BOOK_ID_3 = UUID("00000000-0000-0000-0000-000000000003")

NOW = datetime(2026, 3, 8, 12, 0, 0, tzinfo=timezone.utc)


def make_inventory(book_id: UUID, quantity: int = 50, reserved: int = 5) -> Inventory:
    """Create a mock Inventory ORM object."""
    inv = MagicMock(spec=Inventory)
    inv.book_id = book_id
    inv.quantity = quantity
    inv.reserved = reserved
    inv.available = quantity - reserved
    inv.updated_at = NOW
    return inv


@pytest.fixture
def book_id_1():
    return BOOK_ID_1


@pytest.fixture
def book_id_2():
    return BOOK_ID_2


@pytest.fixture
def sample_inventory():
    return make_inventory(BOOK_ID_1, quantity=50, reserved=5)
