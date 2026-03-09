"""Integration tests for inventory-service stock endpoints.

Tests run against a real PostgreSQL container with Alembic-migrated schema
and seed data (10 books, 50 qty each, 0 reserved).
"""
import asyncio
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tests.integration.conftest import (
    BOOK_ID_1,
    BOOK_ID_2,
    BOOK_ID_3,
    BOOK_IDS,
    UNKNOWN_BOOK_ID,
)

pytestmark = pytest.mark.asyncio


# ── Public stock endpoints ──────────────────────────────────────────────────


class TestGetStock:
    """GET /stock/{book_id} — public single-book stock lookup."""

    async def test_get_stock_returns_seeded_inventory(self, client):
        """Seeded books should have quantity=50, reserved=0, available=50."""
        async with client:
            response = await client.get(f"/stock/{BOOK_ID_1}")

        assert response.status_code == 200
        data = response.json()
        assert data["book_id"] == str(BOOK_ID_1)
        assert data["quantity"] == 50
        assert data["reserved"] == 0
        assert data["available"] == 50
        assert "updated_at" in data

    async def test_get_stock_unknown_book_returns_404(self, client):
        """Unknown book UUID should return 404."""
        async with client:
            response = await client.get(f"/stock/{UNKNOWN_BOOK_ID}")

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    async def test_get_stock_all_seeded_books_exist(self, client):
        """All 10 seeded book IDs should return stock data."""
        async with client:
            for book_id in BOOK_IDS:
                response = await client.get(f"/stock/{book_id}")
                assert response.status_code == 200, f"Book {book_id} not found"


class TestBulkStock:
    """GET /stock/bulk — public bulk stock lookup."""

    async def test_bulk_stock_returns_multiple_items(self, client):
        """Bulk endpoint should return stock for all requested books."""
        ids = ",".join(str(b) for b in BOOK_IDS[:3])
        async with client:
            response = await client.get(f"/stock/bulk?book_ids={ids}")

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 3
        returned_ids = {item["book_id"] for item in data}
        assert returned_ids == {str(b) for b in BOOK_IDS[:3]}

    async def test_bulk_stock_unknown_ids_silently_omitted(self, client):
        """Unknown book IDs should be silently omitted from results."""
        ids = f"{BOOK_ID_1},{UNKNOWN_BOOK_ID}"
        async with client:
            response = await client.get(f"/stock/bulk?book_ids={ids}")

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["book_id"] == str(BOOK_ID_1)

    async def test_bulk_stock_empty_input_returns_empty_list(self, client):
        """Empty book_ids should return an empty list."""
        async with client:
            response = await client.get("/stock/bulk?book_ids=")

        assert response.status_code == 200
        assert response.json() == []

    async def test_bulk_stock_invalid_uuids_skipped(self, client):
        """Invalid UUID strings should be silently skipped."""
        ids = f"not-a-uuid,{BOOK_ID_1}"
        async with client:
            response = await client.get(f"/stock/bulk?book_ids={ids}")

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["book_id"] == str(BOOK_ID_1)


class TestReserveStock:
    """POST /stock/reserve — internal stock reservation."""

    async def test_reserve_deducts_stock_atomically(self, client, db_session):
        """Reserve should increase reserved count, decreasing available."""
        # First check current state
        async with client:
            before = await client.get(f"/stock/{BOOK_ID_1}")
        before_data = before.json()
        initial_reserved = before_data["reserved"]

        # Reserve 3 units
        async with client:
            response = await client.post(
                "/stock/reserve",
                json={"book_id": str(BOOK_ID_1), "quantity": 3},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["book_id"] == str(BOOK_ID_1)
        assert data["quantity_reserved"] == 3
        assert data["remaining_available"] == before_data["available"] - 3

    async def test_reserve_insufficient_stock_returns_409(self, client):
        """Reserving more than available should return 409 Conflict."""
        async with client:
            response = await client.post(
                "/stock/reserve",
                json={"book_id": str(BOOK_ID_2), "quantity": 9999},
            )

        assert response.status_code == 409
        assert "insufficient" in response.json()["detail"].lower()

    async def test_reserve_unknown_book_returns_404(self, client):
        """Reserving stock for unknown book should return 404."""
        async with client:
            response = await client.post(
                "/stock/reserve",
                json={"book_id": str(UNKNOWN_BOOK_ID), "quantity": 1},
            )

        assert response.status_code == 404

    async def test_reserve_concurrent_requests_maintain_consistency(
        self, app_with_test_db
    ):
        """Multiple concurrent reserves should not over-reserve due to row-level locking.

        We use BOOK_ID_3 (which starts with 50 qty, 0 reserved = 50 available).
        5 concurrent reserves of 10 each = 50 total. All should succeed if locking works.
        Then one more reserve of 1 should fail with 409 (no stock left).
        """
        transport = ASGITransport(app=app_with_test_db)

        async def do_reserve():
            async with AsyncClient(transport=transport, base_url="http://test") as c:
                return await c.post(
                    "/stock/reserve",
                    json={"book_id": str(BOOK_ID_3), "quantity": 10},
                )

        # Run 5 concurrent reserves of 10 each
        results = await asyncio.gather(*[do_reserve() for _ in range(5)])
        success_count = sum(1 for r in results if r.status_code == 200)
        conflict_count = sum(1 for r in results if r.status_code == 409)

        # All 5 should succeed (5 * 10 = 50 = full stock)
        assert success_count == 5, (
            f"Expected 5 successes but got {success_count} "
            f"(conflicts: {conflict_count})"
        )

        # One more reserve should fail — no available stock left
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            response = await c.post(
                "/stock/reserve",
                json={"book_id": str(BOOK_ID_3), "quantity": 1},
            )
        assert response.status_code == 409


# ── Admin endpoints ─────────────────────────────────────────────────────────


class TestAdminEndpoints:
    """Admin stock management endpoints — require admin role."""

    @pytest.fixture
    def admin_client(self, app_with_test_db):
        """Client with admin auth dependency overridden to bypass JWT validation."""
        from app.middleware.auth import get_current_user, require_role

        # Override the auth dependency to return an admin user payload
        async def mock_admin_user():
            return {
                "sub": "admin-test-user",
                "roles": ["admin", "customer"],
            }

        app_with_test_db.dependency_overrides[get_current_user] = mock_admin_user
        transport = ASGITransport(app=app_with_test_db)
        return AsyncClient(transport=transport, base_url="http://test")

    @pytest.fixture
    def customer_client(self, app_with_test_db):
        """Client with customer-only role (no admin access)."""
        from app.middleware.auth import get_current_user

        async def mock_customer_user():
            return {
                "sub": "customer-test-user",
                "roles": ["customer"],
            }

        app_with_test_db.dependency_overrides[get_current_user] = mock_customer_user
        transport = ASGITransport(app=app_with_test_db)
        return AsyncClient(transport=transport, base_url="http://test")

    async def test_list_stock_as_admin(self, admin_client):
        """Admin should be able to list all stock entries."""
        async with admin_client:
            response = await admin_client.get("/admin/stock")

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) >= 10  # at least the 10 seeded entries

    async def test_list_stock_as_customer_returns_403(self, customer_client):
        """Customer-role users should get 403 on admin endpoints."""
        async with customer_client:
            response = await customer_client.get("/admin/stock")

        assert response.status_code == 403

    async def test_set_stock_as_admin(self, admin_client):
        """Admin should be able to set absolute stock quantity."""
        # Use a book ID that's not used in other tests to avoid interference
        book_id = BOOK_IDS[4]  # book #5
        async with admin_client:
            response = await admin_client.put(
                f"/admin/stock/{book_id}",
                json={"quantity": 100},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["quantity"] == 100
        assert data["reserved"] == 0
        assert data["available"] == 100

    async def test_adjust_stock_as_admin(self, admin_client):
        """Admin should be able to adjust stock by delta."""
        book_id = BOOK_IDS[5]  # book #6
        async with admin_client:
            # First get current quantity
            stock = await admin_client.get(f"/stock/{book_id}")
            current_qty = stock.json()["quantity"]

            # Adjust by +10
            response = await admin_client.post(
                f"/admin/stock/{book_id}/adjust",
                json={"delta": 10},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["quantity"] == current_qty + 10

    async def test_adjust_stock_negative_below_zero_returns_400(self, admin_client):
        """Adjusting stock below 0 should return 400."""
        book_id = BOOK_IDS[6]  # book #7
        async with admin_client:
            response = await admin_client.post(
                f"/admin/stock/{book_id}/adjust",
                json={"delta": -9999},
            )

        assert response.status_code == 400
        assert "negative" in response.json()["detail"].lower()

    async def test_set_stock_unknown_book_returns_404(self, admin_client):
        """Setting stock for unknown book should return 404."""
        async with admin_client:
            response = await admin_client.put(
                f"/admin/stock/{UNKNOWN_BOOK_ID}",
                json={"quantity": 100},
            )

        assert response.status_code == 404

    async def test_admin_endpoints_require_auth(self, client):
        """Admin endpoints without any auth should return 403 (HTTPBearer rejects)."""
        async with client:
            response = await client.get("/admin/stock")

        # HTTPBearer returns 403 when no Authorization header is present
        assert response.status_code == 403


# ── Health endpoints ────────────────────────────────────────────────────────


class TestHealthEndpoints:
    """Health check endpoints — no auth required."""

    async def test_health_liveness(self, client):
        """Liveness probe should return 200 with status ok."""
        async with client:
            response = await client.get("/health")

        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    async def test_health_readiness(self, client):
        """Readiness probe should return 200 when DB is reachable."""
        async with client:
            response = await client.get("/health/ready")

        assert response.status_code == 200
        assert response.json()["status"] == "ready"
