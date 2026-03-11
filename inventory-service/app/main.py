import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI

# ── OpenTelemetry (enabled when OTEL_EXPORTER_OTLP_ENDPOINT is set) ──────────
_OTEL_ENABLED = False
if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    # Build shared resource with service name + extra attributes from env
    _resource_attrs = {"service.name": os.environ.get("OTEL_SERVICE_NAME", "inventory-service")}
    for pair in os.environ.get("OTEL_RESOURCE_ATTRIBUTES", "").split(","):
        if "=" in pair:
            k, v = pair.split("=", 1)
            _resource_attrs[k.strip()] = v.strip()
    _resource = Resource.create(_resource_attrs)

    # Tracing
    _provider = TracerProvider(resource=_resource)
    _provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(_provider)

    # Logging — export Python logs to OTel Collector → Loki
    if os.environ.get("OTEL_LOGS_EXPORTER", "").lower() == "otlp":
        from opentelemetry._logs import set_logger_provider
        from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
        from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
        from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter

        _log_provider = LoggerProvider(resource=_resource)
        _log_provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter()))
        set_logger_provider(_log_provider)
        _otel_handler = LoggingHandler(level=logging.INFO, logger_provider=_log_provider)

    _OTEL_ENABLED = True
from fastapi.middleware.cors import CORSMiddleware
from prometheus_fastapi_instrumentator import Instrumentator
from pythonjsonlogger.json import JsonFormatter
from sqlalchemy import text

from app.api.admin import router as admin_router
from app.api.stock import router as stock_router
from app.database import AsyncSessionLocal
from app.kafka.consumer import run_consumer_supervised

# ── Structured JSON logging ──────────────────────────────────────────────────
_json_formatter = JsonFormatter(
    fmt="%(asctime)s %(levelname)s %(name)s %(message)s",
    rename_fields={"asctime": "timestamp", "levelname": "level", "name": "logger"},
)

_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(_json_formatter)

logging.root.handlers.clear()
logging.root.addHandler(_handler)
# Attach OTel log handler (sends logs to OTel Collector → Loki)
if _OTEL_ENABLED and os.environ.get("OTEL_LOGS_EXPORTER", "").lower() == "otlp":
    logging.root.addHandler(_otel_handler)
logging.root.setLevel(logging.INFO)

logger = logging.getLogger(__name__)

_consumer_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _consumer_task
    logger.info("Starting Kafka consumer (supervised)...")
    _consumer_task = asyncio.create_task(run_consumer_supervised())
    yield
    if _consumer_task:
        _consumer_task.cancel()
        try:
            await _consumer_task
        except asyncio.CancelledError:
            pass
    logger.info("Inventory service stopped.")


DESCRIPTION = """
## BookStore Inventory Service

Real-time stock management for the BookStore platform.

### Public Endpoints — no authentication required
| Method | Path | Description |
|--------|------|-------------|
| GET | `/stock/{book_id}` | Single book stock lookup |
| GET | `/stock/bulk` | Bulk stock lookup (up to 50 books) |
| GET | `/health` | Kubernetes liveness probe |
| GET | `/health/ready` | Kubernetes readiness probe (checks DB) |

### Admin Endpoints — `admin` Keycloak realm role required
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/stock` | List all stock entries |
| PUT | `/admin/stock/{book_id}` | Set absolute quantity (resets reserved) |
| POST | `/admin/stock/{book_id}/adjust` | Adjust quantity by delta (+/-) |

To test admin endpoints in Swagger UI, click **Authorize** and enter the admin1 Bearer token.

### Internal Endpoints — mTLS + Istio AuthorizationPolicy only
| Method | Path | Description |
|--------|------|-------------|
| POST | `/stock/reserve` | Reserve stock for an order |

The `/stock/reserve` endpoint is **not exposed** through the external Gateway
(blocked at the HTTPRoute level). Only `ecom-service` (identified by its Kubernetes
ServiceAccount SPIFFE identity) may call it over mutual TLS inside the cluster.

### How to authenticate (admin endpoints)
```bash
TOKEN=$(curl -s -X POST \\
  "https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=password&client_id=ui-client&username=admin1&password=CHANGE_ME" \\
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# List all stock (admin)
curl -H "Authorization: Bearer $TOKEN" https://api.service.net:30000/inven/admin/stock

# Set quantity
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"quantity": 100}' \\
  https://api.service.net:30000/inven/admin/stock/00000000-0000-0000-0000-000000000001
```
"""

TAGS_METADATA = [
    {
        "name": "stock",
        "description": "**Public** stock level monitoring. Returns quantity, reserved units, and available units per book.",
    },
    {
        "name": "Admin — Stock",
        "description": "**Admin only.** Stock management: set absolute quantity or adjust by delta. Requires `admin` Keycloak realm role.",
    },
    {
        "name": "reserve",
        "description": "**Internal only.** Stock reservation for checkout. Protected by Istio mTLS — not reachable from outside the cluster.",
    },
    {
        "name": "health",
        "description": "Kubernetes liveness and readiness probe endpoints.",
    },
]

app = FastAPI(
    title="Inventory Service API",
    description=DESCRIPTION,
    version="1.0.0",
    contact={"name": "BookStore Platform", "email": "platform@bookstore.local"},
    license_info={"name": "MIT License", "url": "https://opensource.org/licenses/MIT"},
    openapi_tags=TAGS_METADATA,
    lifespan=lifespan,
    root_path="/inven",
    servers=[
        {
            "url": "https://api.service.net:30000/inven",
            "description": "Kind cluster — Istio Gateway NodePort (external)",
        },
        {
            "url": "http://inventory-service.inventory.svc.cluster.local:8000/inven",
            "description": "Kubernetes cluster-internal URL",
        },
    ],
)

# ── Instrument FastAPI with OpenTelemetry (if enabled) ────────────────────────
if _OTEL_ENABLED:
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    FastAPIInstrumentor.instrument_app(app)

# ── Prometheus metrics (before auth middleware so /metrics is unauthenticated) ─
Instrumentator().instrument(app).expose(app, endpoint="/metrics")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://myecom.net:30000", "https://localhost:30000"],
    allow_methods=["GET", "PUT", "POST", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(stock_router)
app.include_router(admin_router)


@app.get("/health", tags=["health"], summary="Liveness check")
async def health():
    """Returns `{"status": "ok"}` when the process is alive. Used by Kubernetes liveness probe."""
    return {"status": "ok"}


@app.get("/health/ready", tags=["health"], summary="Readiness check")
async def readiness():
    """Checks database connectivity via `SELECT 1`. Returns 503 if the database is unreachable."""
    from fastapi.responses import JSONResponse

    try:
        async with AsyncSessionLocal() as session:
            await session.execute(text("SELECT 1"))
        return {"status": "ready"}
    except Exception as exc:
        logger.error("Readiness check failed: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"status": "not ready", "detail": "database unreachable"},
        )
