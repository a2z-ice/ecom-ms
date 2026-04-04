package com.bookstore.ecom.service;

import com.bookstore.ecom.client.InventoryClient;
import com.bookstore.ecom.dto.OrderCreatedEvent;
import com.bookstore.ecom.exception.BusinessException;
import com.bookstore.ecom.model.CartItem;
import com.bookstore.ecom.model.Order;
import com.bookstore.ecom.model.OrderItem;
import com.bookstore.ecom.model.OutboxEvent;
import com.bookstore.ecom.repository.OrderRepository;
import com.bookstore.ecom.repository.OutboxEventRepository;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;

@Service
@Slf4j
public class OrderService {

    private final CartService cartService;
    private final OrderRepository orderRepository;
    private final OutboxEventRepository outboxRepo;
    private final ObjectMapper objectMapper;
    private final InventoryClient inventoryClient;
    private final Counter ordersTotal;
    private final Timer checkoutDuration;

    public OrderService(CartService cartService, OrderRepository orderRepository,
                        OutboxEventRepository outboxRepo, ObjectMapper objectMapper,
                        InventoryClient inventoryClient,
                        MeterRegistry meterRegistry) {
        this.cartService = cartService;
        this.orderRepository = orderRepository;
        this.outboxRepo = outboxRepo;
        this.objectMapper = objectMapper;
        this.inventoryClient = inventoryClient;
        this.ordersTotal = Counter.builder("orders_total")
            .description("Total number of completed orders")
            .register(meterRegistry);
        this.checkoutDuration = Timer.builder("checkout_duration_seconds")
            .description("Time taken to complete checkout")
            .register(meterRegistry);
    }

    @Transactional
    public Order checkout(String userId, String idempotencyKey) {
        return checkoutDuration.record(() -> {
            // Idempotency check — if key provided and order already exists, return it
            if (idempotencyKey != null && !idempotencyKey.isBlank()) {
                Optional<Order> existing = orderRepository.findByIdempotencyKey(idempotencyKey);
                if (existing.isPresent()) {
                    log.info("Idempotent checkout: returning existing order for key={}", idempotencyKey);
                    return existing.get();
                }
            }

            List<CartItem> cartItems = cartService.getCart(userId);
            if (cartItems.isEmpty()) {
                throw new BusinessException("Cannot checkout: cart is empty");
            }

            // Synchronous mTLS call to inventory-service -- reserve stock before committing order.
            // Istio ztunnel authenticates this pod as principal cluster.local/ns/ecom/sa/ecom-service.
            // The inventory AuthorizationPolicy allows POST /inven/stock/reserve only from this principal.
            for (CartItem cartItem : cartItems) {
                inventoryClient.reserve(cartItem.getBook().getId(), cartItem.getQuantity());
            }

            Order order = new Order();
            order.setUserId(userId);
            order.setStatus("CONFIRMED");
            if (idempotencyKey != null && !idempotencyKey.isBlank()) {
                order.setIdempotencyKey(idempotencyKey);
            }

            BigDecimal total = BigDecimal.ZERO;
            for (CartItem cartItem : cartItems) {
                OrderItem oi = new OrderItem();
                oi.setOrder(order);
                oi.setBook(cartItem.getBook());
                oi.setQuantity(cartItem.getQuantity());
                oi.setPriceAtPurchase(cartItem.getBook().getPrice());
                order.getItems().add(oi);
                total = total.add(cartItem.getBook().getPrice()
                    .multiply(BigDecimal.valueOf(cartItem.getQuantity())));
            }
            order.setTotal(total);

            Order saved = orderRepository.save(order);
            cartService.clearCart(userId);

            // Write event to transactional outbox (same DB transaction as order).
            // OutboxPublisher polls and publishes to Kafka asynchronously.
            OrderCreatedEvent event = new OrderCreatedEvent(
                saved.getId(),
                userId,
                saved.getItems().stream()
                    .map(oi -> new OrderCreatedEvent.OrderItemDto(
                        oi.getBook().getId(),
                        oi.getQuantity(),
                        oi.getPriceAtPurchase()))
                    .toList(),
                saved.getTotal(),
                OffsetDateTime.now()
            );
            try {
                OutboxEvent outboxEvent = new OutboxEvent();
                outboxEvent.setAggregateType("Order");
                outboxEvent.setAggregateId(saved.getId().toString());
                outboxEvent.setEventType("order.created");
                outboxEvent.setPayload(objectMapper.writeValueAsString(event));
                outboxRepo.save(outboxEvent);
            } catch (JacksonException e) {
                throw new RuntimeException("Failed to serialize order event", e);
            }

            ordersTotal.increment();
            log.info("Order created: orderId={} userId={} total={}", saved.getId(), userId, total);
            return saved;
        });
    }
}
