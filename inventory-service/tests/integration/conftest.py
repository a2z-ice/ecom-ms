"""Shared fixtures for inventory-service integration tests.

Uses TestContainers PostgreSQL and runs Alembic migrations to set up the
real schema + seed data. The FastAPI app's database session is overridden
to use the test container's database.
"""
import asyncio
import os
import subprocess
import sys
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

# Book IDs matching the seed data in alembic/versions/002_seed_inventory.py
BOOK_IDS = [UUID(f"00000000-0000-0000-0000-{str(i).zfill(12)}") for i in range(1, 11)]
BOOK_ID_1 = BOOK_IDS[0]
BOOK_ID_2 = BOOK_IDS[1]
BOOK_ID_3 = BOOK_IDS[2]
UNKNOWN_BOOK_ID = UUID("99999999-9999-9999-9999-999999999999")


@pytest.fixture(scope="session")
def postgres_container():
    """Start a PostgreSQL container for the entire test session."""
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest.fixture(scope="session")
def sync_db_url(postgres_container):
    """Synchronous database URL for Alembic migrations."""
    return postgres_container.get_connection_url()


@pytest.fixture(scope="session")
def async_db_url(sync_db_url):
    """Async database URL for SQLAlchemy asyncpg engine."""
    return sync_db_url.replace("postgresql+psycopg2://", "postgresql+asyncpg://")


@pytest.fixture(scope="session", autouse=True)
def run_migrations(sync_db_url):
    """Run Alembic migrations against the test database once per session."""
    env = os.environ.copy()
    env["DATABASE_URL"] = sync_db_url
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=project_root,
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Alembic migrations failed:\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )


@pytest.fixture(scope="session")
def async_engine(async_db_url):
    """Create an async SQLAlchemy engine scoped to the test session."""
    engine = create_async_engine(async_db_url, pool_size=5, max_overflow=10)
    yield engine
    # Engine cleanup happens when the container shuts down


@pytest.fixture(scope="session")
def async_session_factory(async_engine):
    """Session factory for integration tests."""
    return async_sessionmaker(async_engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture
async def db_session(async_session_factory):
    """Provide a transactional database session that rolls back after each test."""
    async with async_session_factory() as session:
        yield session


@pytest.fixture(scope="session")
def app_with_test_db(async_session_factory, sync_db_url):
    """Import and configure the FastAPI app to use the test database.

    Patches environment variables BEFORE importing the app module, then
    overrides the database dependency so all requests use the test container.
    """
    # Set env vars before importing app modules
    os.environ["DATABASE_URL"] = sync_db_url
    os.environ["KEYCLOAK_JWKS_URI"] = "http://localhost:0/not-used"
    os.environ["KEYCLOAK_ISSUER_URI"] = "http://localhost:0/test-issuer"
    os.environ["KAFKA_BOOTSTRAP_SERVERS"] = "localhost:9999"

    # Patch the Kafka consumer so it doesn't try to connect
    with patch("app.kafka.consumer.run_consumer_supervised", new_callable=AsyncMock):
        from app.database import get_db
        from app.main import app

        async def override_get_db():
            async with async_session_factory() as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db
        yield app
        app.dependency_overrides.clear()


@pytest.fixture
def client(app_with_test_db):
    """Provide an httpx AsyncClient configured for the test app."""
    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=app_with_test_db)
    return AsyncClient(transport=transport, base_url="http://test")


def make_admin_auth_header() -> dict:
    """Create a mock Authorization header. Actual JWT validation must be
    bypassed by overriding the auth dependency in specific tests."""
    return {"Authorization": "Bearer fake-admin-token"}
