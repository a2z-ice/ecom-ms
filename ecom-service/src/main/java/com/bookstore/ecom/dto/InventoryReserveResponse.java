package com.bookstore.ecom.dto;

import java.util.UUID;

/**
 * Response body from inventory-service POST /inven/stock/reserve.
 * FastAPI/Pydantic returns snake_case field names; Java record component names match directly.
 */
public record InventoryReserveResponse(UUID book_id, int quantity_reserved, int remaining_available) {}
