package com.bookstore.ecom.dto;

import java.util.UUID;

/**
 * Request body sent to inventory-service POST /inven/stock/reserve.
 * The inventory service (FastAPI/Pydantic) expects snake_case field names.
 * Using snake_case Java record component names so Jackson serializes them as-is.
 */
public record InventoryReserveRequest(UUID book_id, int quantity) {}
