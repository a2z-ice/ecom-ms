package com.bookstore.ecom.controller;

import com.bookstore.ecom.dto.OrderResponse;
import com.bookstore.ecom.model.Order;
import com.bookstore.ecom.service.OrderService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/checkout")
@RequiredArgsConstructor
public class OrderController {

    private final OrderService orderService;

    @PostMapping
    public ResponseEntity<OrderResponse> checkout(@AuthenticationPrincipal Jwt jwt) {
        Order order = orderService.checkout(jwt.getSubject());
        return ResponseEntity.ok(OrderResponse.from(order));
    }
}
