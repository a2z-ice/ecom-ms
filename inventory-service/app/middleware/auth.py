"""JWT validation middleware using Keycloak JWKS endpoint."""
import logging

import httpx
from cachetools import TTLCache
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from app.config import settings

logger = logging.getLogger(__name__)

_bearer = HTTPBearer()
_jwks_cache: TTLCache = TTLCache(maxsize=1, ttl=300)
_JWKS_KEY = "jwks"


async def _get_jwks() -> dict:
    cached = _jwks_cache.get(_JWKS_KEY)
    if cached is not None:
        return cached
    async with httpx.AsyncClient() as client:
        resp = await client.get(settings.keycloak_jwks_uri)
        resp.raise_for_status()
        jwks = resp.json()
    _jwks_cache[_JWKS_KEY] = jwks
    logger.info("JWKS fetched and cached (TTL=300s)")
    return jwks


def _invalidate_jwks_cache() -> None:
    _jwks_cache.pop(_JWKS_KEY, None)


async def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict:
    token = creds.credentials
    try:
        jwks = await _get_jwks()
        payload = jwt.decode(
            token,
            jwks,
            algorithms=["RS256"],
            options={"verify_aud": True},
            audience=settings.jwt_audience,
            issuer=settings.keycloak_issuer_uri,
        )
        return payload
    except JWTError:
        # Invalidate cache and retry once with fresh JWKS (handles key rotation)
        _invalidate_jwks_cache()
        try:
            jwks = await _get_jwks()
            payload = jwt.decode(
                token,
                jwks,
                algorithms=["RS256"],
                options={"verify_aud": True},
                audience=settings.jwt_audience,
                issuer=settings.keycloak_issuer_uri,
            )
            logger.info("JWT validated after JWKS cache refresh")
            return payload
        except JWTError as exc:
            logger.warning("JWT validation failed after JWKS refresh: %s", exc)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired token",
                headers={"WWW-Authenticate": "Bearer"},
            )


def require_role(role: str):
    """Dependency factory — raises 403 if the required role is not in the token."""
    async def _check(user: dict = Depends(get_current_user)) -> dict:
        roles = user.get("roles", [])
        if role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{role}' required",
            )
        return user
    return _check
