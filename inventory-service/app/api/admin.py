"""Admin-only stock management endpoints.

All routes require the ``admin`` Keycloak realm role.
Customer-role tokens receive ``403 Forbidden``.

Routes are NOT reachable via external gateway by default — the inven-route HTTPRoute
must explicitly expose /inven/admin/** (added in Session 21).
"""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.kafka.dlq_consumer import dlq_monitor, retry_dlq_message
from app.middleware.auth import require_role
from app.models.inventory import Inventory
from app.schemas.inventory import (
    StockAdminResponse,
    StockAdjustRequest,
    StockResponse,
    StockSetRequest,
)

router = APIRouter(prefix="/admin/stock", tags=["Admin — Stock"])


def _to_response(inv: Inventory) -> StockAdminResponse:
    return StockAdminResponse(
        book_id=inv.book_id,
        quantity=inv.quantity,
        reserved=inv.reserved,
        available=inv.available,
        updated_at=inv.updated_at,
    )


@router.get(
    "",
    response_model=list[StockResponse],
    summary="List all stock entries",
    description="""
Returns the full stock table — all books with their current `quantity`, `reserved`, and
`available` values.

**Requires `admin` Keycloak realm role.** Customer-role tokens receive `403 Forbidden`.
""",
    responses={
        200: {"description": "Full stock list"},
        401: {"description": "Missing or invalid Bearer token"},
        403: {"description": "Role 'admin' required"},
    },
)
async def list_stock(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(require_role("admin")),
    page: Annotated[int, Query(ge=0, description="Page number (0-based)")] = 0,
    size: Annotated[int, Query(ge=1, le=200, description="Items per page")] = 50,
):
    """Return all inventory records, paginated."""
    result = await db.execute(
        select(Inventory).order_by(Inventory.book_id).offset(page * size).limit(size)
    )
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


@router.put(
    "/{book_id}",
    response_model=StockAdminResponse,
    summary="Set absolute quantity",
    description="""
Sets the **absolute** total quantity for a book. Resets `reserved` to 0.

Use this endpoint when doing a full stock count (e.g. after a physical inventory audit).

**Requires `admin` Keycloak realm role.**
""",
    responses={
        200: {"description": "Stock updated"},
        401: {"description": "Missing or invalid Bearer token"},
        403: {"description": "Role 'admin' required"},
        404: {"description": "Book not found in inventory"},
    },
)
async def set_stock(
    book_id: UUID,
    request: StockSetRequest,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(require_role("admin")),
):
    """Set absolute stock quantity for a book. Resets reserved to 0."""
    result = await db.execute(
        select(Inventory).where(Inventory.book_id == book_id).with_for_update()
    )
    inv = result.scalar_one_or_none()
    if inv is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found in inventory")
    inv.quantity = request.quantity
    inv.reserved = 0
    await db.commit()
    await db.refresh(inv)
    return _to_response(inv)


@router.post(
    "/{book_id}/adjust",
    response_model=StockAdminResponse,
    summary="Adjust quantity by delta",
    description="""
Adjusts the total quantity by a signed **delta** (positive = add stock, negative = remove stock).
The `reserved` count is not modified.

**Constraint:** resulting `quantity` cannot go below 0.

Use this endpoint for incremental adjustments (e.g. received 20 new copies, or wrote off 5 damaged).

**Requires `admin` Keycloak realm role.**
""",
    responses={
        200: {"description": "Stock adjusted"},
        400: {"description": "Adjustment would result in negative quantity"},
        401: {"description": "Missing or invalid Bearer token"},
        403: {"description": "Role 'admin' required"},
        404: {"description": "Book not found in inventory"},
    },
)
async def adjust_stock(
    book_id: UUID,
    request: StockAdjustRequest,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(require_role("admin")),
):
    """Adjust stock quantity by a signed delta."""
    result = await db.execute(
        select(Inventory).where(Inventory.book_id == book_id).with_for_update()
    )
    inv = result.scalar_one_or_none()
    if inv is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found in inventory")
    new_qty = inv.quantity + request.delta
    if new_qty < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Adjustment would result in negative quantity: current={inv.quantity} delta={request.delta}",
        )
    inv.quantity = new_qty
    await db.commit()
    await db.refresh(inv)
    return _to_response(inv)


@router.get("/dlq", tags=["Admin — DLQ"], summary="List DLQ messages")
async def list_dlq_messages(
    _user=Depends(require_role("admin")),
):
    """Returns dead-letter queue messages (last 100) and total count."""
    return {
        "totalCount": dlq_monitor.total_count,
        "messages": dlq_monitor.messages,
    }


@router.post("/dlq/{msg_id}/retry", tags=["Admin — DLQ"], summary="Retry a DLQ message")
async def retry_message(
    msg_id: int,
    _user=Depends(require_role("admin")),
):
    """Re-publish a DLQ message back to the source topic for reprocessing."""
    result = await retry_dlq_message(msg_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"DLQ message #{msg_id} not found")
    return result
