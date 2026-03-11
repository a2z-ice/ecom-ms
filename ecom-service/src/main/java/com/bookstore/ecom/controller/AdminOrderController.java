package com.bookstore.ecom.controller;

import com.bookstore.ecom.dto.AdminOrderResponse;
import com.bookstore.ecom.exception.ResourceNotFoundException;
import com.bookstore.ecom.model.Order;
import com.bookstore.ecom.repository.OrderRepository;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * Admin-only order management. Requires the {@code admin} Keycloak realm role.
 * Returns all orders across all users (unlike the customer-facing checkout endpoint).
 */
@RestController
@RequestMapping("/admin/orders")
@RequiredArgsConstructor
@PreAuthorize("hasRole('ADMIN')")
@Tag(name = "Admin — Orders",
    description = "Read-only access to all orders across all users. **Requires `admin` Keycloak realm role.**")
@SecurityRequirement(name = "BearerAuth")
public class AdminOrderController {

    private final OrderRepository orderRepository;

    @Operation(
        summary = "List all orders",
        description = "Returns all orders across all users, paginated and sorted by creation date descending. Admin-only."
    )
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Order list"),
        @ApiResponse(responseCode = "403", description = "Insufficient role — admin required"),
    })
    @GetMapping
    public ResponseEntity<Page<AdminOrderResponse>> listOrders(
            @Parameter(description = "Pagination: `?page=0&size=20`")
            @PageableDefault(size = 20) Pageable pageable) {
        Page<AdminOrderResponse> page = orderRepository.findAllOrderByCreatedAtDesc(pageable)
            .map(AdminOrderResponse::from);
        return ResponseEntity.ok(page);
    }

    @Operation(summary = "Get order by ID", description = "Returns a single order with all line items. Admin-only.")
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Order found"),
        @ApiResponse(responseCode = "403", description = "Insufficient role — admin required"),
        @ApiResponse(responseCode = "404", description = "Order not found"),
    })
    @GetMapping("/{id}")
    public ResponseEntity<AdminOrderResponse> getOrder(
            @Parameter(description = "Order UUID") @PathVariable UUID id) {
        Order order = orderRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("Order not found: " + id));
        return ResponseEntity.ok(AdminOrderResponse.from(order));
    }
}
