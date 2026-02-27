from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user, require_role
from app.models.inventory import Inventory
from app.schemas.inventory import ReserveRequest, ReserveResponse, StockResponse

router = APIRouter(prefix="/stock", tags=["stock"])


@router.get("/{book_id}", response_model=StockResponse)
async def get_stock(book_id: UUID, db: AsyncSession = Depends(get_db)):
    """Public endpoint — no authentication required."""
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


@router.post("/reserve", response_model=ReserveResponse)
async def reserve_stock(
    request: ReserveRequest,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_role("admin")),  # Internal: only called by ecom-service (mTLS + admin role)
):
    """Internal endpoint — called by ecom-service over mTLS. Requires admin role."""
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
