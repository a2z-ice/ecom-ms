package com.bookstore.ecom.controller;

import com.bookstore.ecom.dto.OrderResponse;
import com.bookstore.ecom.model.Order;
import com.bookstore.ecom.service.OrderService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
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
@Tag(name = "Checkout", description = "Order placement. Requires a valid Bearer JWT token.")
@SecurityRequirement(name = "BearerAuth")
public class OrderController {

    private final OrderService orderService;

    @Operation(
        summary = "Place order (checkout)",
        description = """
            Converts the authenticated user's cart into a confirmed order.

            **What this endpoint does:**
            1. Reads all items from the user's server-side cart
            2. Calls the Inventory Service via mTLS to reserve stock for each item
            3. Creates an order record in the database
            4. Publishes an `order.created` event to Kafka for the CDC pipeline
            5. Clears the user's cart

            **Failure modes:**
            - `409 CONFLICT` — Inventory service returned insufficient stock for one or more items
            - `422 UNPROCESSABLE_ENTITY` — Cart is empty
            - `503 SERVICE_UNAVAILABLE` — Inventory service unreachable

            The operation is **atomic per item**: if any item fails stock reservation, the entire
            checkout is rejected and no order is created.
            """
    )
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Order placed successfully — cart is now empty"),
        @ApiResponse(responseCode = "401", description = "Bearer token missing or invalid"),
        @ApiResponse(responseCode = "409", description = "Insufficient stock for one or more items",
            content = @Content(schema = @Schema(
                example = "{\"status\":409,\"detail\":\"Insufficient stock: available=2 requested=5\"}"))),
        @ApiResponse(responseCode = "422", description = "Cart is empty — nothing to checkout",
            content = @Content(schema = @Schema(
                example = "{\"status\":422,\"detail\":\"Cart is empty\"}"))),
    })
    @PostMapping
    public ResponseEntity<OrderResponse> checkout(@AuthenticationPrincipal Jwt jwt) {
        Order order = orderService.checkout(jwt.getSubject());
        return ResponseEntity.ok(OrderResponse.from(order));
    }
}
