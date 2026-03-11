"""Unit tests for JWKS cache with TTL and JWT validation."""
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from fastapi import HTTPException
from jose import JWTError

from app.middleware.auth import _get_jwks, _invalidate_jwks_cache, _jwks_cache, _JWKS_KEY, get_current_user


FAKE_JWKS = {"keys": [{"kty": "RSA", "kid": "test-key-1", "n": "abc", "e": "AQAB"}]}
FAKE_JWKS_ROTATED = {"keys": [{"kty": "RSA", "kid": "test-key-2", "n": "xyz", "e": "AQAB"}]}
FAKE_PAYLOAD = {"sub": "user-123", "roles": ["customer"]}


@pytest.fixture(autouse=True)
def clear_jwks_cache():
    """Ensure the JWKS cache is empty before each test."""
    _jwks_cache.clear()
    yield
    _jwks_cache.clear()


def _mock_creds(token: str = "fake-jwt-token"):
    creds = MagicMock()
    creds.credentials = token
    return creds


class TestJWKSCache:
    """Tests for _get_jwks() caching behavior."""

    @pytest.mark.asyncio
    async def test_jwks_fetched_and_cached(self):
        """JWKS is fetched on first call and cached on second call."""
        mock_response = AsyncMock()
        mock_response.json.return_value = FAKE_JWKS
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.get.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("app.middleware.auth.httpx.AsyncClient", return_value=mock_client):
            # First call: fetches from remote
            result1 = await _get_jwks()
            assert result1 == FAKE_JWKS
            assert mock_client.get.call_count == 1

            # Second call: returns from cache (no new HTTP call)
            result2 = await _get_jwks()
            assert result2 == FAKE_JWKS
            assert mock_client.get.call_count == 1  # still 1

    @pytest.mark.asyncio
    async def test_expired_cache_triggers_refetch(self):
        """When the cache entry is evicted (simulating TTL expiry), a new fetch occurs."""
        mock_response = AsyncMock()
        mock_response.json.return_value = FAKE_JWKS
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.get.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("app.middleware.auth.httpx.AsyncClient", return_value=mock_client):
            # Populate cache
            await _get_jwks()
            assert mock_client.get.call_count == 1

            # Simulate TTL expiry by clearing cache
            _jwks_cache.clear()

            # Should fetch again
            await _get_jwks()
            assert mock_client.get.call_count == 2


class TestGetCurrentUser:
    """Tests for get_current_user() JWT validation with cache invalidation retry."""

    @pytest.mark.asyncio
    async def test_valid_token_returns_payload(self):
        """A valid JWT returns the decoded payload."""
        with (
            patch("app.middleware.auth._get_jwks", new_callable=AsyncMock, return_value=FAKE_JWKS),
            patch("app.middleware.auth.jwt.decode", return_value=FAKE_PAYLOAD),
        ):
            result = await get_current_user(_mock_creds("valid-token"))
            assert result == FAKE_PAYLOAD
            assert result["sub"] == "user-123"

    @pytest.mark.asyncio
    async def test_jwt_error_invalidates_cache_and_retries(self):
        """First JWTError invalidates cache; retry with fresh JWKS succeeds."""
        call_count = 0

        def decode_side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise JWTError("Signature verification failed")
            return FAKE_PAYLOAD

        with (
            patch("app.middleware.auth._get_jwks", new_callable=AsyncMock, return_value=FAKE_JWKS),
            patch("app.middleware.auth.jwt.decode", side_effect=decode_side_effect),
            patch("app.middleware.auth._invalidate_jwks_cache") as mock_invalidate,
        ):
            result = await get_current_user(_mock_creds("needs-refresh-token"))
            assert result == FAKE_PAYLOAD
            mock_invalidate.assert_called_once()

    @pytest.mark.asyncio
    async def test_second_jwt_error_after_retry_returns_401(self):
        """If JWT validation fails even after cache refresh, raise 401."""
        with (
            patch("app.middleware.auth._get_jwks", new_callable=AsyncMock, return_value=FAKE_JWKS),
            patch("app.middleware.auth.jwt.decode", side_effect=JWTError("Bad token")),
            patch("app.middleware.auth._invalidate_jwks_cache"),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await get_current_user(_mock_creds("bad-token"))
            assert exc_info.value.status_code == 401
            assert "Invalid or expired token" in exc_info.value.detail


class TestInvalidateJWKSCache:
    """Tests for _invalidate_jwks_cache()."""

    def test_invalidate_removes_cached_entry(self):
        """_invalidate_jwks_cache removes the JWKS entry from the cache."""
        _jwks_cache[_JWKS_KEY] = FAKE_JWKS
        assert _JWKS_KEY in _jwks_cache

        _invalidate_jwks_cache()
        assert _JWKS_KEY not in _jwks_cache

    def test_invalidate_noop_when_empty(self):
        """_invalidate_jwks_cache does not raise when cache is already empty."""
        _invalidate_jwks_cache()  # should not raise
