package com.bookstore.ecom.service;

import com.bookstore.ecom.dto.CartRequest;
import com.bookstore.ecom.exception.ResourceNotFoundException;
import com.bookstore.ecom.model.Book;
import com.bookstore.ecom.model.CartItem;
import com.bookstore.ecom.repository.BookRepository;
import com.bookstore.ecom.repository.CartItemRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class CartServiceTest {

    @Mock
    private CartItemRepository cartItemRepository;

    @Mock
    private BookRepository bookRepository;

    @InjectMocks
    private CartService cartService;

    private static final String USER_ID = "user-123";
    private Book testBook;

    @BeforeEach
    void setUp() {
        testBook = new Book();
        testBook.setId(UUID.randomUUID());
        testBook.setTitle("Test Book");
        testBook.setAuthor("Test Author");
        testBook.setPrice(new BigDecimal("19.99"));
    }

    @Test
    @DisplayName("getCart returns items with books eagerly loaded via EntityGraph")
    void getCart_returnsItemsWithBooks() {
        CartItem item1 = new CartItem();
        item1.setId(UUID.randomUUID());
        item1.setUserId(USER_ID);
        item1.setBook(testBook);
        item1.setQuantity(2);

        Book secondBook = new Book();
        secondBook.setId(UUID.randomUUID());
        secondBook.setTitle("Second Book");
        secondBook.setPrice(new BigDecimal("29.99"));

        CartItem item2 = new CartItem();
        item2.setId(UUID.randomUUID());
        item2.setUserId(USER_ID);
        item2.setBook(secondBook);
        item2.setQuantity(1);

        when(cartItemRepository.findByUserId(USER_ID)).thenReturn(List.of(item1, item2));

        List<CartItem> result = cartService.getCart(USER_ID);

        assertThat(result).hasSize(2);
        // Verify books are accessible (eagerly loaded via @EntityGraph)
        assertThat(result.get(0).getBook()).isNotNull();
        assertThat(result.get(0).getBook().getTitle()).isEqualTo("Test Book");
        assertThat(result.get(1).getBook()).isNotNull();
        assertThat(result.get(1).getBook().getTitle()).isEqualTo("Second Book");
        verify(cartItemRepository).findByUserId(USER_ID);
    }

    @Test
    @DisplayName("addToCart creates new cart item when book not in cart")
    void addToCart_createsNewItem() {
        UUID bookId = testBook.getId();
        CartRequest request = new CartRequest(bookId, 3);

        when(bookRepository.findById(bookId)).thenReturn(Optional.of(testBook));
        when(cartItemRepository.findByUserIdAndBookId(USER_ID, bookId)).thenReturn(Optional.empty());
        when(cartItemRepository.save(any(CartItem.class))).thenAnswer(invocation -> {
            CartItem saved = invocation.getArgument(0);
            saved.setId(UUID.randomUUID());
            return saved;
        });

        CartItem result = cartService.addToCart(USER_ID, request);

        assertThat(result.getUserId()).isEqualTo(USER_ID);
        assertThat(result.getBook()).isEqualTo(testBook);
        assertThat(result.getQuantity()).isEqualTo(3);

        ArgumentCaptor<CartItem> captor = ArgumentCaptor.forClass(CartItem.class);
        verify(cartItemRepository).save(captor.capture());
        CartItem savedItem = captor.getValue();
        assertThat(savedItem.getUserId()).isEqualTo(USER_ID);
        assertThat(savedItem.getQuantity()).isEqualTo(3);
    }

    @Test
    @DisplayName("addToCart increments quantity when book already in cart")
    void addToCart_incrementsExistingItem() {
        UUID bookId = testBook.getId();
        CartRequest request = new CartRequest(bookId, 2);

        CartItem existing = new CartItem();
        existing.setId(UUID.randomUUID());
        existing.setUserId(USER_ID);
        existing.setBook(testBook);
        existing.setQuantity(3);

        when(bookRepository.findById(bookId)).thenReturn(Optional.of(testBook));
        when(cartItemRepository.findByUserIdAndBookId(USER_ID, bookId)).thenReturn(Optional.of(existing));
        when(cartItemRepository.save(any(CartItem.class))).thenAnswer(invocation -> invocation.getArgument(0));

        CartItem result = cartService.addToCart(USER_ID, request);

        assertThat(result.getQuantity()).isEqualTo(5); // 3 + 2
        verify(cartItemRepository).save(existing);
    }

    @Test
    @DisplayName("addToCart throws ResourceNotFoundException for unknown book")
    void addToCart_bookNotFound() {
        UUID bookId = UUID.randomUUID();
        CartRequest request = new CartRequest(bookId, 1);

        when(bookRepository.findById(bookId)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> cartService.addToCart(USER_ID, request))
            .isInstanceOf(ResourceNotFoundException.class)
            .hasMessageContaining("Book not found");
    }

    @Test
    @DisplayName("removeItem deletes item when user owns it")
    void removeItem_success() {
        UUID itemId = UUID.randomUUID();
        CartItem item = new CartItem();
        item.setId(itemId);
        item.setUserId(USER_ID);
        item.setBook(testBook);

        when(cartItemRepository.findById(itemId)).thenReturn(Optional.of(item));

        cartService.removeItem(USER_ID, itemId);

        verify(cartItemRepository).delete(item);
    }

    @Test
    @DisplayName("removeItem throws ResourceNotFoundException when item belongs to different user")
    void removeItem_ownershipCheck() {
        UUID itemId = UUID.randomUUID();
        CartItem item = new CartItem();
        item.setId(itemId);
        item.setUserId("other-user");
        item.setBook(testBook);

        when(cartItemRepository.findById(itemId)).thenReturn(Optional.of(item));

        assertThatThrownBy(() -> cartService.removeItem(USER_ID, itemId))
            .isInstanceOf(ResourceNotFoundException.class)
            .hasMessageContaining("Cart item not found");

        verify(cartItemRepository, never()).delete(any());
    }

    @Test
    @DisplayName("removeItem throws ResourceNotFoundException when item does not exist")
    void removeItem_notFound() {
        UUID itemId = UUID.randomUUID();
        when(cartItemRepository.findById(itemId)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> cartService.removeItem(USER_ID, itemId))
            .isInstanceOf(ResourceNotFoundException.class)
            .hasMessageContaining("Cart item not found");
    }

    @Test
    @DisplayName("setQuantity updates quantity for owned item")
    void setQuantity_success() {
        UUID itemId = UUID.randomUUID();
        CartItem item = new CartItem();
        item.setId(itemId);
        item.setUserId(USER_ID);
        item.setBook(testBook);
        item.setQuantity(3);

        when(cartItemRepository.findById(itemId)).thenReturn(Optional.of(item));
        when(cartItemRepository.save(any(CartItem.class))).thenAnswer(invocation -> invocation.getArgument(0));

        CartItem result = cartService.setQuantity(USER_ID, itemId, 7);

        assertThat(result.getQuantity()).isEqualTo(7);
        verify(cartItemRepository).save(item);
    }

    @Test
    @DisplayName("setQuantity throws ResourceNotFoundException for different user's item")
    void setQuantity_ownershipCheck() {
        UUID itemId = UUID.randomUUID();
        CartItem item = new CartItem();
        item.setId(itemId);
        item.setUserId("other-user");

        when(cartItemRepository.findById(itemId)).thenReturn(Optional.of(item));

        assertThatThrownBy(() -> cartService.setQuantity(USER_ID, itemId, 5))
            .isInstanceOf(ResourceNotFoundException.class);

        verify(cartItemRepository, never()).save(any());
    }

    @Test
    @DisplayName("clearCart delegates to repository")
    void clearCart_deletesAllUserItems() {
        cartService.clearCart(USER_ID);

        verify(cartItemRepository).deleteByUserId(USER_ID);
    }
}
