package com.bookstore.ecom.controller;

import com.bookstore.ecom.dto.CartRequest;
import com.bookstore.ecom.dto.CartUpdateRequest;
import com.bookstore.ecom.model.CartItem;
import com.bookstore.ecom.service.CartService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
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
@Tag(name = "Cart", description = "Shopping cart management. All endpoints require a valid Bearer JWT token.")
@SecurityRequirement(name = "BearerAuth")
public class CartController {

    private final CartService cartService;

    @Operation(
        summary = "Get cart items",
        description = "Returns all items currently in the authenticated user's server-side cart, "
            + "including nested book details and quantities."
    )
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Cart items list (may be empty)"),
        @ApiResponse(responseCode = "401", description = "Bearer token missing or invalid",
            content = @Content(schema = @Schema(example = "{\"error\":\"Unauthorized\"}"))),
    })
    @GetMapping
    public ResponseEntity<List<CartItem>> getCart(@AuthenticationPrincipal Jwt jwt) {
        return ResponseEntity.ok(cartService.getCart(jwt.getSubject()));
    }

    @Operation(
        summary = "Add book to cart",
        description = "Adds a book to the authenticated user's cart. If the book is already in the cart, "
            + "the quantity is incremented by the specified amount. "
            + "Minimum quantity is 1 (validated server-side)."
    )
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Cart item created or updated"),
        @ApiResponse(responseCode = "400", description = "Validation error — quantity < 1 or bookId missing",
            content = @Content(schema = @Schema(example = "{\"status\":400,\"detail\":\"quantity must be >= 1\"}"))),
        @ApiResponse(responseCode = "401", description = "Bearer token missing or invalid"),
        @ApiResponse(responseCode = "404", description = "Book not found",
            content = @Content(schema = @Schema(example = "{\"status\":404,\"detail\":\"Book not found\"}"))),
    })
    @PostMapping
    public ResponseEntity<CartItem> addToCart(
            @AuthenticationPrincipal Jwt jwt,
            @Valid @RequestBody CartRequest request) {
        return ResponseEntity.ok(cartService.addToCart(jwt.getSubject(), request));
    }

    @Operation(
        summary = "Update cart item quantity",
        description = "Sets the quantity of a specific cart item to an exact value. "
            + "Use `DELETE /{itemId}` to remove an item instead of setting quantity to 0. "
            + "Minimum allowed quantity via this endpoint is 1."
    )
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Cart item updated"),
        @ApiResponse(responseCode = "400", description = "Validation error — quantity < 1"),
        @ApiResponse(responseCode = "401", description = "Bearer token missing or invalid"),
        @ApiResponse(responseCode = "404", description = "Cart item not found or does not belong to this user"),
    })
    @PutMapping("/{itemId}")
    public ResponseEntity<CartItem> updateCartItem(
            @AuthenticationPrincipal Jwt jwt,
            @Parameter(description = "Cart item UUID", required = true) @PathVariable UUID itemId,
            @Valid @RequestBody CartUpdateRequest request) {
        return ResponseEntity.ok(cartService.setQuantity(jwt.getSubject(), itemId, request.quantity()));
    }

    @Operation(
        summary = "Remove cart item",
        description = "Permanently removes a specific item from the authenticated user's cart."
    )
    @ApiResponses({
        @ApiResponse(responseCode = "204", description = "Item removed successfully"),
        @ApiResponse(responseCode = "401", description = "Bearer token missing or invalid"),
        @ApiResponse(responseCode = "404", description = "Cart item not found or does not belong to this user"),
    })
    @DeleteMapping("/{itemId}")
    public ResponseEntity<Void> removeFromCart(
            @AuthenticationPrincipal Jwt jwt,
            @Parameter(description = "Cart item UUID", required = true) @PathVariable UUID itemId) {
        cartService.removeItem(jwt.getSubject(), itemId);
        return ResponseEntity.noContent().build();
    }
}
