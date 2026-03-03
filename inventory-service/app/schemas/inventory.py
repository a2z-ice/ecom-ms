from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class StockResponse(BaseModel):
    book_id: UUID = Field(
        description="Unique identifier of the book (matches `id` in the E-Commerce catalog API)",
        examples=["00000000-0000-0000-0000-000000000001"],
    )
    quantity: int = Field(
        description="Total physical stock count (quantity ordered from supplier)",
        examples=[50],
    )
    reserved: int = Field(
        description="Units currently reserved for in-progress orders (not yet fulfilled)",
        examples=[5],
    )
    available: int = Field(
        description="Units available for new purchases — computed as `quantity - reserved`",
        examples=[45],
    )
    updated_at: datetime = Field(
        description="ISO 8601 timestamp of the last stock update (UTC)",
        examples=["2026-03-02T14:30:00Z"],
    )

    model_config = {"from_attributes": True}


class ReserveRequest(BaseModel):
    book_id: UUID = Field(
        description="UUID of the book to reserve stock for",
        examples=["00000000-0000-0000-0000-000000000001"],
    )
    quantity: int = Field(
        description="Number of units to reserve (must be >= 1)",
        examples=[2],
        ge=1,
    )


class ReserveResponse(BaseModel):
    book_id: UUID = Field(description="UUID of the book whose stock was reserved")
    quantity_reserved: int = Field(description="Number of units successfully reserved")
    remaining_available: int = Field(description="Available units remaining after this reservation")


class StockSetRequest(BaseModel):
    """Admin: set the absolute quantity for a book (resets reserved to 0)."""
    quantity: int = Field(
        description="New absolute total quantity. Resets `reserved` to 0.",
        examples=[100],
        ge=0,
    )


class StockAdjustRequest(BaseModel):
    """Admin: adjust stock by a signed delta (+/-)."""
    delta: int = Field(
        description="Units to add (positive) or remove (negative). "
            "Result quantity cannot go below 0.",
        examples=[10],
    )


class StockAdminResponse(BaseModel):
    """Admin response after setting or adjusting stock."""
    book_id: UUID = Field(description="Book UUID")
    quantity: int = Field(description="New total quantity")
    reserved: int = Field(description="Current reserved units")
    available: int = Field(description="New available units (quantity - reserved)")
    updated_at: datetime = Field(description="Timestamp of the update")
