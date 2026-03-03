package com.bookstore.ecom.controller;

import com.bookstore.ecom.model.Book;
import com.bookstore.ecom.service.BookService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.tags.Tag;
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
@Tag(name = "Catalog", description = "Browse and search the book catalog. All endpoints are **public** — no authentication required.")
public class BookController {

    private final BookService bookService;

    @Operation(
        summary = "List all books (paginated)",
        description = "Returns a paginated list of all books sorted by title. "
            + "Supports standard Spring Pageable parameters: `page` (0-based), `size`, `sort`."
    )
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Paginated book list returned"),
    })
    @GetMapping
    public ResponseEntity<Page<Book>> listBooks(
            @Parameter(description = "Pagination and sorting. Example: `?page=0&size=20&sort=title`")
            @PageableDefault(size = 20, sort = "title") Pageable pageable) {
        return ResponseEntity.ok(bookService.findAll(pageable));
    }

    @Operation(
        summary = "Search books",
        description = "Full-text search across **title**, **author**, and **genre** fields. "
            + "Case-insensitive. Returns an empty page if no matches are found."
    )
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Search results (may be empty)"),
        @ApiResponse(responseCode = "400", description = "Missing required `q` parameter",
            content = @Content(schema = @Schema(example = "{\"status\":400,\"detail\":\"Required parameter 'q' is not present\"}"))),
    })
    @GetMapping("/search")
    public ResponseEntity<Page<Book>> searchBooks(
            @Parameter(description = "Search query — title, author, or genre keyword", example = "tolkien", required = true)
            @RequestParam String q,
            @Parameter(description = "Pagination parameters")
            @PageableDefault(size = 20) Pageable pageable) {
        return ResponseEntity.ok(bookService.search(q, pageable));
    }

    @Operation(
        summary = "Get book by ID",
        description = "Returns the full details for a single book, including description, ISBN, genre, and published year."
    )
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Book found"),
        @ApiResponse(responseCode = "404", description = "Book not found",
            content = @Content(schema = @Schema(example = "{\"status\":404,\"detail\":\"Book not found\"}"))),
    })
    @GetMapping("/{id}")
    public ResponseEntity<Book> getBook(
            @Parameter(description = "Book UUID", example = "00000000-0000-0000-0000-000000000001", required = true)
            @PathVariable UUID id) {
        return ResponseEntity.ok(bookService.findById(id));
    }
}
