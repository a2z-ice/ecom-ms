package com.bookstore.ecom.dto;

import com.bookstore.ecom.model.Order;
import io.swagger.v3.oas.annotations.media.Schema;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Schema(description = "Full order details for admin view (includes items and user ID)")
public record AdminOrderResponse(

    @Schema(description = "Order UUID")
    UUID id,

    @Schema(description = "Keycloak user UUID who placed the order")
    String userId,

    @Schema(description = "Total price in USD")
    BigDecimal total,

    @Schema(description = "Order status (CONFIRMED, PENDING, etc.)")
    String status,

    @Schema(description = "When the order was created")
    OffsetDateTime createdAt,

    @Schema(description = "Line items")
    List<OrderItemDto> items

) {

    @Schema(description = "A single line item within an order")
    public record OrderItemDto(
        @Schema(description = "Book UUID") UUID bookId,
        @Schema(description = "Book title") String title,
        @Schema(description = "Quantity ordered") int quantity,
        @Schema(description = "Price per unit at time of purchase") BigDecimal priceAtPurchase
    ) {}

    public static AdminOrderResponse from(Order order) {
        List<OrderItemDto> items = order.getItems().stream()
            .map(oi -> new OrderItemDto(
                oi.getBook().getId(),
                oi.getBook().getTitle(),
                oi.getQuantity(),
                oi.getPriceAtPurchase()))
            .toList();
        return new AdminOrderResponse(
            order.getId(),
            order.getUserId(),
            order.getTotal(),
            order.getStatus(),
            order.getCreatedAt(),
            items);
    }
}
