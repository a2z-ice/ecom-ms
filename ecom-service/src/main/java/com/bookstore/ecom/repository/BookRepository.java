package com.bookstore.ecom.repository;

import com.bookstore.ecom.model.Book;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.UUID;

public interface BookRepository extends JpaRepository<Book, UUID> {

    @Query("""
        SELECT b FROM Book b
        WHERE LOWER(b.title) LIKE LOWER(CONCAT('%', :q, '%'))
           OR LOWER(b.author) LIKE LOWER(CONCAT('%', :q, '%'))
           OR LOWER(b.genre) LIKE LOWER(CONCAT('%', :q, '%'))
        """)
    Page<Book> search(@Param("q") String query, Pageable pageable);
}
