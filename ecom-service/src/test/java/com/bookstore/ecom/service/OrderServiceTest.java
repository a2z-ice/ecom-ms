package com.bookstore.ecom.service;

import com.bookstore.ecom.client.InventoryClient;
import com.bookstore.ecom.dto.InventoryReserveResponse;
import com.bookstore.ecom.dto.OrderCreatedEvent;
import com.bookstore.ecom.exception.BusinessException;
import com.bookstore.ecom.kafka.OrderEventPublisher;
import com.bookstore.ecom.model.Book;
import com.bookstore.ecom.model.CartItem;
import com.bookstore.ecom.model.Order;
import com.bookstore.ecom.repository.OrderRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class OrderServiceTest {

    @Mock
    private CartService cartService;

    @Mock
    private OrderRepository orderRepository;

    @Mock
    private OrderEventPublisher eventPublisher;

    @Mock
    private InventoryClient inventoryClient;

    @InjectMocks
    private OrderService orderService;

    private static final String USER_ID = "user-456";
    private Book book1;
    private Book book2;

    @BeforeEach
    void setUp() {
        book1 = new Book();
        book1.setId(UUID.randomUUID());
        book1.setTitle("Book One");
        book1.setPrice(new BigDecimal("10.00"));

        book2 = new Book();
        book2.setId(UUID.randomUUID());
        book2.setTitle("Book Two");
        book2.setPrice(new BigDecimal("20.00"));
    }

    private CartItem makeCartItem(Book book, int quantity) {
        CartItem item = new CartItem();
        item.setId(UUID.randomUUID());
        item.setUserId(USER_ID);
        item.setBook(book);
        item.setQuantity(quantity);
        return item;
    }

    @Test
    @DisplayName("Successful checkout creates order, calls inventory reserve, publishes event, clears cart")
    void checkout_success() {
        CartItem cartItem1 = makeCartItem(book1, 2);  // 2 x $10 = $20
        CartItem cartItem2 = makeCartItem(book2, 1);  // 1 x $20 = $20
        List<CartItem> cartItems = List.of(cartItem1, cartItem2);

        when(cartService.getCart(USER_ID)).thenReturn(cartItems);

        // Inventory reserve succeeds for both books
        when(inventoryClient.reserve(eq(book1.getId()), eq(2)))
            .thenReturn(new InventoryReserveResponse(book1.getId(), 2, 8));
        when(inventoryClient.reserve(eq(book2.getId()), eq(1)))
            .thenReturn(new InventoryReserveResponse(book2.getId(), 1, 9));

        // Order save returns the order with an ID assigned
        when(orderRepository.save(any(Order.class))).thenAnswer(invocation -> {
            Order order = invocation.getArgument(0);
            order.setId(UUID.randomUUID());
            return order;
        });

        Order result = orderService.checkout(USER_ID);

        // Verify order properties
        assertThat(result.getUserId()).isEqualTo(USER_ID);
        assertThat(result.getStatus()).isEqualTo("CONFIRMED");
        assertThat(result.getTotal()).isEqualByComparingTo(new BigDecimal("40.00")); // $20 + $20
        assertThat(result.getItems()).hasSize(2);

        // Verify inventory reserve was called for each cart item
        verify(inventoryClient).reserve(book1.getId(), 2);
        verify(inventoryClient).reserve(book2.getId(), 1);

        // Verify order was saved
        verify(orderRepository).save(any(Order.class));

        // Verify cart was cleared
        verify(cartService).clearCart(USER_ID);

        // Verify Kafka event was published
        ArgumentCaptor<OrderCreatedEvent> eventCaptor = ArgumentCaptor.forClass(OrderCreatedEvent.class);
        verify(eventPublisher).publishOrderCreated(eventCaptor.capture());
        OrderCreatedEvent event = eventCaptor.getValue();
        assertThat(event.userId()).isEqualTo(USER_ID);
        assertThat(event.total()).isEqualByComparingTo(new BigDecimal("40.00"));
        assertThat(event.items()).hasSize(2);
    }

    @Test
    @DisplayName("Checkout with empty cart throws BusinessException")
    void checkout_emptyCart_throwsBusinessException() {
        when(cartService.getCart(USER_ID)).thenReturn(new ArrayList<>());

        assertThatThrownBy(() -> orderService.checkout(USER_ID))
            .isInstanceOf(BusinessException.class)
            .hasMessageContaining("cart is empty");

        // Verify nothing else was called
        verifyNoInteractions(inventoryClient);
        verifyNoInteractions(orderRepository);
        verifyNoInteractions(eventPublisher);
        verify(cartService, never()).clearCart(any());
    }

    @Test
    @DisplayName("Checkout when inventory reserve fails throws BusinessException")
    void checkout_inventoryReserveFails_throwsException() {
        CartItem cartItem = makeCartItem(book1, 100);
        when(cartService.getCart(USER_ID)).thenReturn(List.of(cartItem));

        // Inventory service rejects — insufficient stock
        when(inventoryClient.reserve(eq(book1.getId()), eq(100)))
            .thenThrow(new BusinessException("Insufficient stock for book: " + book1.getId()));

        assertThatThrownBy(() -> orderService.checkout(USER_ID))
            .isInstanceOf(BusinessException.class)
            .hasMessageContaining("Insufficient stock");

        // Order should NOT be saved, cart should NOT be cleared, event should NOT be published
        verifyNoInteractions(orderRepository);
        verifyNoInteractions(eventPublisher);
        verify(cartService, never()).clearCart(any());
    }

    @Test
    @DisplayName("Checkout when inventory service is unavailable throws BusinessException")
    void checkout_inventoryUnavailable_throwsException() {
        CartItem cartItem = makeCartItem(book1, 1);
        when(cartService.getCart(USER_ID)).thenReturn(List.of(cartItem));

        when(inventoryClient.reserve(eq(book1.getId()), eq(1)))
            .thenThrow(new BusinessException("Inventory service temporarily unavailable"));

        assertThatThrownBy(() -> orderService.checkout(USER_ID))
            .isInstanceOf(BusinessException.class)
            .hasMessageContaining("Inventory service temporarily unavailable");

        verifyNoInteractions(orderRepository);
        verifyNoInteractions(eventPublisher);
    }

    @Test
    @DisplayName("Checkout order items have correct price and quantity from cart")
    void checkout_orderItemsMatchCart() {
        CartItem cartItem = makeCartItem(book1, 3); // 3 x $10.00
        when(cartService.getCart(USER_ID)).thenReturn(List.of(cartItem));
        when(inventoryClient.reserve(eq(book1.getId()), eq(3)))
            .thenReturn(new InventoryReserveResponse(book1.getId(), 3, 7));

        when(orderRepository.save(any(Order.class))).thenAnswer(invocation -> {
            Order order = invocation.getArgument(0);
            order.setId(UUID.randomUUID());
            return order;
        });

        Order result = orderService.checkout(USER_ID);

        assertThat(result.getItems()).hasSize(1);
        assertThat(result.getItems().get(0).getQuantity()).isEqualTo(3);
        assertThat(result.getItems().get(0).getPriceAtPurchase()).isEqualByComparingTo(new BigDecimal("10.00"));
        assertThat(result.getItems().get(0).getBook().getId()).isEqualTo(book1.getId());
        assertThat(result.getTotal()).isEqualByComparingTo(new BigDecimal("30.00"));
    }
}
