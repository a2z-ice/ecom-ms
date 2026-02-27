from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from app.config import settings

# Convert sync URL to async URL for asyncpg
_async_url = settings.database_url.replace("postgresql://", "postgresql+asyncpg://")

engine = create_async_engine(_async_url, pool_size=5, max_overflow=10)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session
