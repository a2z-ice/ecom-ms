package com.bookstore.ecom.controller;

import com.bookstore.ecom.model.Book;
import com.bookstore.ecom.service.BookService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.http.ResponseEntity;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class BookControllerTest {

    @Mock
    private BookService bookService;

    @InjectMocks
    private BookController bookController;

    private Book testBook;

    @BeforeEach
    void setUp() {
        testBook = new Book();
        testBook.setId(UUID.fromString("00000000-0000-0000-0000-000000000001"));
        testBook.setTitle("The Hobbit");
        testBook.setAuthor("J.R.R. Tolkien");
        testBook.setPrice(new BigDecimal("12.99"));
        testBook.setGenre("Fantasy");
    }

    @Test
    @DisplayName("listBooks returns response with Cache-Control: max-age=60, public")
    void listBooks_hasCacheControlHeader() {
        Page<Book> page = new PageImpl<>(List.of(testBook));
        when(bookService.findAll(any(Pageable.class))).thenReturn(page);

        ResponseEntity<Page<Book>> response = bookController.listBooks(PageRequest.of(0, 20));

        assertThat(response.getHeaders().getCacheControl()).isEqualTo("max-age=60, public");
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().getContent()).hasSize(1);
    }

    @Test
    @DisplayName("searchBooks returns response with Cache-Control: max-age=60, public")
    void searchBooks_hasCacheControlHeader() {
        Page<Book> page = new PageImpl<>(List.of(testBook));
        when(bookService.search(eq("tolkien"), any(Pageable.class))).thenReturn(page);

        ResponseEntity<Page<Book>> response = bookController.searchBooks("tolkien", PageRequest.of(0, 20));

        assertThat(response.getHeaders().getCacheControl()).isEqualTo("max-age=60, public");
        assertThat(response.getBody()).isNotNull();
    }

    @Test
    @DisplayName("listBooks with empty results still has Cache-Control header")
    void searchBooks_emptyResults_hasCacheControl() {
        Page<Book> empty = new PageImpl<>(List.of());
        when(bookService.search(eq("nonexistent"), any(Pageable.class))).thenReturn(empty);

        ResponseEntity<Page<Book>> response = bookController.searchBooks("nonexistent", PageRequest.of(0, 20));

        assertThat(response.getHeaders().getCacheControl()).isEqualTo("max-age=60, public");
        assertThat(response.getBody().getTotalElements()).isZero();
    }

    @Test
    @DisplayName("getBook returns book without Cache-Control header")
    void getBook_noCacheControl() {
        when(bookService.findById(testBook.getId())).thenReturn(testBook);

        ResponseEntity<Book> response = bookController.getBook(testBook.getId());

        assertThat(response.getHeaders().getCacheControl()).isNullOrEmpty();
        assertThat(response.getBody().getTitle()).isEqualTo("The Hobbit");
    }
}
