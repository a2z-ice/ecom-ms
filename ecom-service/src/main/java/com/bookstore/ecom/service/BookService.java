package com.bookstore.ecom.service;

import com.bookstore.ecom.dto.BookRequest;
import com.bookstore.ecom.exception.ResourceNotFoundException;
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
            .orElseThrow(() -> new ResourceNotFoundException("Book not found: " + id));
    }

    @Transactional
    public Book create(BookRequest req) {
        Book book = new Book();
        applyRequest(book, req);
        return bookRepository.save(book);
    }

    @Transactional
    public Book update(UUID id, BookRequest req) {
        Book book = findById(id);
        applyRequest(book, req);
        return bookRepository.save(book);
    }

    @Transactional
    public void delete(UUID id) {
        Book book = findById(id);
        bookRepository.delete(book);
    }

    private void applyRequest(Book book, BookRequest req) {
        book.setTitle(req.title());
        book.setAuthor(req.author());
        book.setPrice(req.price());
        book.setDescription(req.description());
        book.setCoverUrl(req.coverUrl());
        book.setIsbn(req.isbn());
        book.setGenre(req.genre());
        book.setPublishedYear(req.publishedYear());
    }
}
