"""Unit tests for stock API endpoints."""
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.database import get_db
from app.models.inventory import Inventory

from tests.conftest import BOOK_ID_1, BOOK_ID_2, BOOK_ID_3, NOW, make_inventory


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_real_inventory(book_id: UUID, quantity: int = 50, reserved: int = 5) -> Inventory:
    """Create a real Inventory ORM instance (not a mock) so .available property works."""
    inv = Inventory.__new__(Inventory)
    inv.book_id = book_id
    inv.quantity = quantity
    inv.reserved = reserved
    inv.updated_at = NOW
    return inv


class _FakeScalarsResult:
    """Mimics the result of result.scalars().all() or result.scalar_one_or_none()."""

    def __init__(self, items: list):
        self._items = items

    def all(self):
        return self._items


class _FakeResult:
    """Mimics SQLAlchemy async result."""

    def __init__(self, items: list | None = None, single: object | None = None):
        self._items = items or []
        self._single = single

    def scalars(self):
        return _FakeScalarsResult(self._items)

    def scalar_one_or_none(self):
        return self._single


def _make_mock_db(inventory_items: list | None = None, single: object | None = None):
    """Create a mock async DB session."""
    db = AsyncMock()
    result = _FakeResult(items=inventory_items, single=single)
    db.execute = AsyncMock(return_value=result)
    db.commit = AsyncMock()
    return db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def client():
    """Synchronous test client for FastAPI app."""
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestGetStock:
    """Tests for GET /stock/{book_id}."""

    def test_get_stock_returns_stock(self, client):
        """GET /stock/{book_id} returns stock data for a known book."""
        inv = _make_real_inventory(BOOK_ID_1, quantity=50, reserved=5)
        mock_db = _make_mock_db(single=inv)

        app.dependency_overrides[get_db] = lambda: mock_db
        try:
            response = client.get(f"/stock/{BOOK_ID_1}")
            assert response.status_code == 200
            body = response.json()
            assert body["book_id"] == str(BOOK_ID_1)
            assert body["quantity"] == 50
            assert body["reserved"] == 5
            assert body["available"] == 45
        finally:
            app.dependency_overrides.clear()

    def test_get_stock_not_found(self, client):
        """GET /stock/{book_id} returns 404 for an unknown book."""
        mock_db = _make_mock_db(single=None)

        app.dependency_overrides[get_db] = lambda: mock_db
        try:
            response = client.get(f"/stock/{BOOK_ID_1}")
            assert response.status_code == 404
            assert "not found" in response.json()["detail"].lower()
        finally:
            app.dependency_overrides.clear()


class TestGetBulkStock:
    """Tests for GET /stock/bulk?book_ids=..."""

    def test_bulk_stock_returns_multiple(self, client):
        """GET /stock/bulk returns stock for multiple books."""
        inv1 = _make_real_inventory(BOOK_ID_1, quantity=50, reserved=5)
        inv2 = _make_real_inventory(BOOK_ID_2, quantity=30, reserved=0)
        mock_db = _make_mock_db(inventory_items=[inv1, inv2])

        app.dependency_overrides[get_db] = lambda: mock_db
        try:
            response = client.get(f"/stock/bulk?book_ids={BOOK_ID_1},{BOOK_ID_2}")
            assert response.status_code == 200
            body = response.json()
            assert len(body) == 2
            ids = {item["book_id"] for item in body}
            assert str(BOOK_ID_1) in ids
            assert str(BOOK_ID_2) in ids
        finally:
            app.dependency_overrides.clear()

    def test_bulk_stock_empty_ids_returns_empty(self, client):
        """GET /stock/bulk with empty book_ids returns empty list."""
        mock_db = _make_mock_db(inventory_items=[])

        app.dependency_overrides[get_db] = lambda: mock_db
        try:
            response = client.get("/stock/bulk?book_ids=")
            assert response.status_code == 200
            assert response.json() == []
        finally:
            app.dependency_overrides.clear()

    def test_bulk_stock_skips_invalid_uuids(self, client):
        """GET /stock/bulk silently skips invalid UUID strings."""
        inv1 = _make_real_inventory(BOOK_ID_1, quantity=50, reserved=5)
        mock_db = _make_mock_db(inventory_items=[inv1])

        app.dependency_overrides[get_db] = lambda: mock_db
        try:
            response = client.get(f"/stock/bulk?book_ids={BOOK_ID_1},not-a-uuid,{BOOK_ID_2}")
            assert response.status_code == 200
            # Should not error out due to the invalid UUID
        finally:
            app.dependency_overrides.clear()


class TestReserveStock:
    """Tests for POST /stock/reserve."""

    def test_reserve_stock_success(self, client):
        """POST /stock/reserve reserves stock correctly."""
        inv = _make_real_inventory(BOOK_ID_1, quantity=50, reserved=5)
        mock_db = _make_mock_db(single=inv)

        app.dependency_overrides[get_db] = lambda: mock_db
        try:
            response = client.post(
                "/stock/reserve",
                json={"book_id": str(BOOK_ID_1), "quantity": 3},
            )
            assert response.status_code == 200
            body = response.json()
            assert body["book_id"] == str(BOOK_ID_1)
            assert body["quantity_reserved"] == 3
            # After reserving 3 more: reserved = 5+3=8, available = 50-8=42
            assert body["remaining_available"] == 42
            mock_db.commit.assert_called_once()
        finally:
            app.dependency_overrides.clear()

    def test_reserve_insufficient_stock_returns_409(self, client):
        """POST /stock/reserve with insufficient stock returns 409."""
        inv = _make_real_inventory(BOOK_ID_1, quantity=10, reserved=8)
        # available = 10 - 8 = 2
        mock_db = _make_mock_db(single=inv)

        app.dependency_overrides[get_db] = lambda: mock_db
        try:
            response = client.post(
                "/stock/reserve",
                json={"book_id": str(BOOK_ID_1), "quantity": 5},
            )
            assert response.status_code == 409
            assert "Insufficient stock" in response.json()["detail"]
        finally:
            app.dependency_overrides.clear()

    def test_reserve_book_not_found_returns_404(self, client):
        """POST /stock/reserve for unknown book returns 404."""
        mock_db = _make_mock_db(single=None)

        app.dependency_overrides[get_db] = lambda: mock_db
        try:
            response = client.post(
                "/stock/reserve",
                json={"book_id": str(BOOK_ID_1), "quantity": 1},
            )
            assert response.status_code == 404
        finally:
            app.dependency_overrides.clear()
