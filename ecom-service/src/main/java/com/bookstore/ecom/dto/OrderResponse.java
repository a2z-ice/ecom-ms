package com.bookstore.ecom.dto;

import com.bookstore.ecom.model.Order;

import java.math.BigDecimal;
import java.util.UUID;

public record OrderResponse(UUID id, BigDecimal total, String status) {
    public static OrderResponse from(Order order) {
        return new OrderResponse(order.getId(), order.getTotal(), order.getStatus());
    }
}
