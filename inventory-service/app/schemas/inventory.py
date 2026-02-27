from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class StockResponse(BaseModel):
    book_id: UUID
    quantity: int
    reserved: int
    available: int
    updated_at: datetime

    model_config = {"from_attributes": True}


class ReserveRequest(BaseModel):
    book_id: UUID
    quantity: int


class ReserveResponse(BaseModel):
    book_id: UUID
    quantity_reserved: int
    remaining_available: int
