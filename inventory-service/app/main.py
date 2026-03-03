import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.admin import router as admin_router
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


DESCRIPTION = """
## BookStore Inventory Service

Real-time stock management for the BookStore platform.

### Public Endpoints — no authentication required
| Method | Path | Description |
|--------|------|-------------|
| GET | `/stock/{book_id}` | Single book stock lookup |
| GET | `/stock/bulk` | Bulk stock lookup (up to 50 books) |
| GET | `/health` | Kubernetes liveness/readiness probe |

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
  "http://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=password&client_id=ui-client&username=admin1&password=CHANGE_ME" \\
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# List all stock (admin)
curl -H "Authorization: Bearer $TOKEN" http://api.service.net:30000/inven/admin/stock

# Set quantity
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"quantity": 100}' \\
  http://api.service.net:30000/inven/admin/stock/00000000-0000-0000-0000-000000000001
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
        "description": "Kubernetes liveness and readiness probe endpoint.",
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
            "url": "http://api.service.net:30000/inven",
            "description": "Kind cluster — Istio Gateway NodePort (external)",
        },
        {
            "url": "http://inventory-service.inventory.svc.cluster.local:8000/inven",
            "description": "Kubernetes cluster-internal URL",
        },
    ],
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://myecom.net:30000", "http://localhost:30000"],
    allow_methods=["GET", "PUT", "POST", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(stock_router)
app.include_router(admin_router)


@app.get("/health", tags=["health"], summary="Health check")
async def health():
    """Returns `{"status": "ok"}` when the service is running. Used by Kubernetes probes."""
    return {"status": "ok"}
