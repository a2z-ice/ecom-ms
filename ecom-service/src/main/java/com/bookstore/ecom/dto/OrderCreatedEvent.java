package com.bookstore.ecom.dto;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

public record OrderCreatedEvent(
    UUID orderId,
    String userId,
    List<OrderItemDto> items,
    BigDecimal total,
    OffsetDateTime timestamp
) {
    public record OrderItemDto(UUID bookId, int quantity, BigDecimal price) {}
}
