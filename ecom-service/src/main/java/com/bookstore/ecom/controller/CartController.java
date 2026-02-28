package com.bookstore.ecom.controller;

import com.bookstore.ecom.dto.CartRequest;
import com.bookstore.ecom.dto.CartUpdateRequest;
import com.bookstore.ecom.model.CartItem;
import com.bookstore.ecom.service.CartService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/cart")
@RequiredArgsConstructor
public class CartController {

    private final CartService cartService;

    @GetMapping
    public ResponseEntity<List<CartItem>> getCart(@AuthenticationPrincipal Jwt jwt) {
        return ResponseEntity.ok(cartService.getCart(jwt.getSubject()));
    }

    @PostMapping
    public ResponseEntity<CartItem> addToCart(
            @AuthenticationPrincipal Jwt jwt,
            @Valid @RequestBody CartRequest request) {
        return ResponseEntity.ok(cartService.addToCart(jwt.getSubject(), request));
    }

    @PutMapping("/{itemId}")
    public ResponseEntity<CartItem> updateCartItem(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID itemId,
            @Valid @RequestBody CartUpdateRequest request) {
        return ResponseEntity.ok(cartService.setQuantity(jwt.getSubject(), itemId, request.quantity()));
    }

    @DeleteMapping("/{itemId}")
    public ResponseEntity<Void> removeFromCart(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID itemId) {
        cartService.removeItem(jwt.getSubject(), itemId);
        return ResponseEntity.noContent().build();
    }
}
