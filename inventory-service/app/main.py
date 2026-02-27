import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.stock import router as stock_router
from app.kafka.consumer import run_consumer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

_consumer_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _consumer_task
    logger.info("Starting Kafka consumer...")
    _consumer_task = asyncio.create_task(run_consumer())
    yield
    if _consumer_task:
        _consumer_task.cancel()
        try:
            await _consumer_task
        except asyncio.CancelledError:
            pass
    logger.info("Inventory service stopped.")


app = FastAPI(
    title="Inventory Service",
    description="Book stock management",
    version="0.1.0",
    lifespan=lifespan,
    root_path="/inven",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://myecom.net:30000"],
    allow_methods=["GET"],
    allow_headers=["Authorization"],
)

app.include_router(stock_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
