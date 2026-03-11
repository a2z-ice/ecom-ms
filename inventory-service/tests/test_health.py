"""Unit tests for health and readiness endpoints."""
from unittest.mock import AsyncMock, patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    """Synchronous test client for FastAPI app (no lifespan to avoid Kafka)."""
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


class TestHealthEndpoint:
    """Tests for GET /health (liveness probe)."""

    def test_health_returns_200_ok(self, client):
        """GET /health returns 200 with {"status": "ok"}."""
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


class TestReadinessEndpoint:
    """Tests for GET /health/ready (readiness probe)."""

    def test_ready_returns_200_when_db_reachable(self, client):
        """GET /health/ready returns 200 when the database responds to SELECT 1."""
        mock_session = AsyncMock()
        mock_session.execute = AsyncMock()
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch("app.main.AsyncSessionLocal", return_value=mock_session):
            response = client.get("/health/ready")
            assert response.status_code == 200
            assert response.json() == {"status": "ready"}

    def test_ready_returns_503_when_db_unreachable(self, client):
        """GET /health/ready returns 503 when the database connection fails."""
        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(side_effect=ConnectionRefusedError("Connection refused"))
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch("app.main.AsyncSessionLocal", return_value=mock_session):
            response = client.get("/health/ready")
            assert response.status_code == 503
            body = response.json()
            assert body["status"] == "not ready"
            assert "database unreachable" in body["detail"]
