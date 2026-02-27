package com.bookstore.ecom.service;

import com.bookstore.ecom.model.Book;
import com.bookstore.ecom.repository.BookRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class BookService {

    private final BookRepository bookRepository;

    public Page<Book> findAll(Pageable pageable) {
        return bookRepository.findAll(pageable);
    }

    public Page<Book> search(String query, Pageable pageable) {
        return bookRepository.search(query, pageable);
    }

    public Book findById(UUID id) {
        return bookRepository.findById(id)
            .orElseThrow(() -> new com.bookstore.ecom.exception.ResourceNotFoundException("Book not found: " + id));
    }
}
