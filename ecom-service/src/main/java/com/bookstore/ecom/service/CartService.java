package com.bookstore.ecom.service;

import com.bookstore.ecom.dto.CartRequest;
import com.bookstore.ecom.model.Book;
import com.bookstore.ecom.model.CartItem;
import com.bookstore.ecom.repository.BookRepository;
import com.bookstore.ecom.repository.CartItemRepository;
import com.bookstore.ecom.exception.ResourceNotFoundException;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Service
@RequiredArgsConstructor
public class CartService {

    private final CartItemRepository cartItemRepository;
    private final BookRepository bookRepository;

    @Transactional(readOnly = true)
    public List<CartItem> getCart(String userId) {
        return cartItemRepository.findByUserId(userId);
    }

    @Transactional
    public CartItem addToCart(String userId, CartRequest request) {
        Book book = bookRepository.findById(request.bookId())
            .orElseThrow(() -> new ResourceNotFoundException("Book not found: " + request.bookId()));

        return cartItemRepository.findByUserIdAndBookId(userId, request.bookId())
            .map(existing -> {
                existing.setQuantity(existing.getQuantity() + request.quantity());
                return cartItemRepository.save(existing);
            })
            .orElseGet(() -> {
                CartItem item = new CartItem();
                item.setUserId(userId);
                item.setBook(book);
                item.setQuantity(request.quantity());
                return cartItemRepository.save(item);
            });
    }

    @Transactional
    public void removeItem(String userId, UUID itemId) {
        CartItem item = cartItemRepository.findById(itemId)
            .orElseThrow(() -> new ResourceNotFoundException("Cart item not found: " + itemId));
        if (!item.getUserId().equals(userId)) {
            throw new ResourceNotFoundException("Cart item not found: " + itemId);
        }
        cartItemRepository.delete(item);
    }

    @Transactional
    public void clearCart(String userId) {
        cartItemRepository.deleteByUserId(userId);
    }
}
