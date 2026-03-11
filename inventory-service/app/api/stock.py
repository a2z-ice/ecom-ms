from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.inventory import Inventory
from app.schemas.inventory import ReserveRequest, ReserveResponse, StockResponse

router = APIRouter(prefix="/stock", tags=["stock"])


@router.get(
    "/bulk",
    response_model=list[StockResponse],
    summary="Bulk stock lookup",
    description="""
Retrieve stock levels for up to **50 books** in a single request.

This endpoint powers the UI's stock badge system — the catalog and search pages
call it once after loading books to display In Stock / Low Stock / Out of Stock badges.

**Behavior:**
- Unknown book IDs are **silently omitted** from the response (no 404)
- Invalid UUID strings are silently skipped
- Empty `book_ids` returns `[]`
- Maximum 50 IDs per request (extras truncated)

**Public** — no authentication required.
""",
    responses={
        200: {"description": "Array of stock records for known book IDs (may be shorter than input)"},
        422: {"description": "Validation error — `book_ids` query parameter is missing"},
    },
)
async def get_bulk_stock(
    book_ids: Annotated[
        str,
        Query(
            description="Comma-separated list of book UUIDs. Unknown or invalid UUIDs are silently omitted. Max 50.",
            openapi_examples={
                "two_books": {
                    "summary": "Two specific books",
                    "value": "00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002",
                }
            },
        ),
    ],
    db: AsyncSession = Depends(get_db),
):
    """Return stock for multiple books in one DB query. Unknown IDs are silently omitted."""
    raw_ids = [i.strip() for i in book_ids.split(",") if i.strip()][:50]
    ids = []
    for raw in raw_ids:
        try:
            ids.append(UUID(raw))
        except ValueError:
            pass  # skip invalid UUIDs
    if not ids:
        return []
    result = await db.execute(select(Inventory).where(Inventory.book_id.in_(ids)))
    return [
        StockResponse(
            book_id=inv.book_id,
            quantity=inv.quantity,
            reserved=inv.reserved,
            available=inv.available,
            updated_at=inv.updated_at,
        )
        for inv in result.scalars().all()
    ]


@router.get(
    "/{book_id}",
    response_model=StockResponse,
    summary="Get stock for a single book",
    description="""
Returns the current stock level for a single book.

**Public** — no authentication required.

**Stock status interpretation:**
| `available` value | UI display | Button state |
|---|---|---|
| `0` | 🔴 Out of Stock | Disabled |
| `1–3` | 🟠 Only X left | Enabled |
| `> 3` | 🟢 In Stock | Enabled |
""",
    responses={
        200: {"description": "Stock record found"},
        404: {
            "description": "Book not found in inventory",
            "content": {
                "application/json": {
                    "example": {"detail": "Book not found in inventory"},
                }
            },
        },
    },
)
async def get_stock(book_id: UUID, db: AsyncSession = Depends(get_db)):
    """Return stock for a single book by UUID. Returns 404 if not found in inventory."""
    result = await db.execute(select(Inventory).where(Inventory.book_id == book_id))
    inv = result.scalar_one_or_none()
    if inv is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found in inventory")
    return StockResponse(
        book_id=inv.book_id,
        quantity=inv.quantity,
        reserved=inv.reserved,
        available=inv.available,
        updated_at=inv.updated_at,
    )


@router.post(
    "/reserve",
    response_model=ReserveResponse,
    summary="Reserve stock — internal mTLS only",
    description="""
Atomically reserves stock for a book. Called by `ecom-service` at checkout.

**This endpoint is NOT reachable from outside the cluster.** It is blocked at three layers:
1. **Gateway HTTPRoute** — no route matches `POST /inven/stock/reserve` externally (returns 404)
2. **Istio AuthorizationPolicy** — only SPIFFE identity `cluster.local/ns/ecom/sa/ecom-service` allowed
3. **NetworkPolicy** — only pods in `ecom` namespace can reach the `inventory` namespace on port 8000

**Atomicity:** Uses `SELECT ... FOR UPDATE` row lock to prevent double-booking.
Returns `409 CONFLICT` if `available < requested quantity`.
""",
    tags=["reserve"],
    responses={
        200: {"description": "Stock reserved successfully"},
        404: {"description": "Book not found in inventory"},
        409: {
            "description": "Insufficient stock",
            "content": {
                "application/json": {
                    "example": {"detail": "Insufficient stock: available=2 requested=5"},
                }
            },
        },
    },
)
async def reserve_stock(
    request: ReserveRequest,
    db: AsyncSession = Depends(get_db),
):
    """Reserve stock for an order. Returns 409 if insufficient available units."""
    result = await db.execute(
        select(Inventory).where(Inventory.book_id == request.book_id).with_for_update()
    )
    inv = result.scalar_one_or_none()
    if inv is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found in inventory")
    if inv.available < request.quantity:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Insufficient stock: available={inv.available} requested={request.quantity}",
        )
    inv.reserved += request.quantity
    await db.commit()
    return ReserveResponse(
        book_id=inv.book_id,
        quantity_reserved=request.quantity,
        remaining_available=inv.available,
    )
