package com.bookstore.ecom.service;

import com.bookstore.ecom.client.InventoryClient;
import com.bookstore.ecom.dto.OrderCreatedEvent;
import com.bookstore.ecom.exception.BusinessException;
import com.bookstore.ecom.kafka.OrderEventPublisher;
import com.bookstore.ecom.model.CartItem;
import com.bookstore.ecom.model.Order;
import com.bookstore.ecom.model.OrderItem;
import com.bookstore.ecom.repository.OrderRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;

@Service
@RequiredArgsConstructor
@Slf4j
public class OrderService {

    private final CartService cartService;
    private final OrderRepository orderRepository;
    private final OrderEventPublisher eventPublisher;
    private final InventoryClient inventoryClient;

    @Transactional
    public Order checkout(String userId) {
        List<CartItem> cartItems = cartService.getCart(userId);
        if (cartItems.isEmpty()) {
            throw new BusinessException("Cannot checkout: cart is empty");
        }

        // Synchronous mTLS call to inventory-service — reserve stock before committing order.
        // Istio ztunnel authenticates this pod as principal cluster.local/ns/ecom/sa/ecom-service.
        // The inventory AuthorizationPolicy allows POST /inven/stock/reserve only from this principal.
        for (CartItem cartItem : cartItems) {
            inventoryClient.reserve(cartItem.getBook().getId(), cartItem.getQuantity());
        }

        Order order = new Order();
        order.setUserId(userId);
        order.setStatus("CONFIRMED");

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

        // Publish event to Kafka
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
        eventPublisher.publishOrderCreated(event);

        log.info("Order created: orderId={} userId={} total={}", saved.getId(), userId, total);
        return saved;
    }
}
