package com.bookstore.ecom.controller;

import com.bookstore.ecom.model.Book;
import com.bookstore.ecom.service.BookService;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

@RestController
@RequestMapping("/books")
@RequiredArgsConstructor
public class BookController {

    private final BookService bookService;

    @GetMapping
    public ResponseEntity<Page<Book>> listBooks(
            @PageableDefault(size = 20, sort = "title") Pageable pageable) {
        return ResponseEntity.ok(bookService.findAll(pageable));
    }

    @GetMapping("/search")
    public ResponseEntity<Page<Book>> searchBooks(
            @RequestParam String q,
            @PageableDefault(size = 20) Pageable pageable) {
        return ResponseEntity.ok(bookService.search(q, pageable));
    }

    @GetMapping("/{id}")
    public ResponseEntity<Book> getBook(@PathVariable UUID id) {
        return ResponseEntity.ok(bookService.findById(id));
    }
}
