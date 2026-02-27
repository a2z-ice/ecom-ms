package com.bookstore.ecom.repository;

import com.bookstore.ecom.model.CartItem;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface CartItemRepository extends JpaRepository<CartItem, UUID> {
    List<CartItem> findByUserId(String userId);
    Optional<CartItem> findByUserIdAndBookId(String userId, UUID bookId);
    void deleteByUserId(String userId);
}
