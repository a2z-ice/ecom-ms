package com.bookstore.ecom.controller;

import com.bookstore.ecom.dto.BookRequest;
import com.bookstore.ecom.model.Book;
import com.bookstore.ecom.service.BookService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

import java.net.URI;
import java.util.UUID;

/**
 * Admin-only book management. Requires the {@code admin} Keycloak realm role.
 * Customer-role users receive 403 Forbidden.
 */
@RestController
@RequestMapping("/admin/books")
@RequiredArgsConstructor
@PreAuthorize("hasRole('ADMIN')")
@Tag(name = "Admin — Books",
    description = "Create, update, and delete books. **Requires `admin` Keycloak realm role.** "
        + "Customer-role requests return `403 Forbidden`.")
@SecurityRequirement(name = "BearerAuth")
public class AdminBookController {

    private final BookService bookService;

    @Operation(summary = "List all books (admin view)", description = "Returns paginated list of all books. Admin-only.")
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Book list"),
        @ApiResponse(responseCode = "403", description = "Insufficient role — admin required"),
    })
    @GetMapping
    public ResponseEntity<Page<Book>> listBooks(
            @Parameter(description = "Pagination: `?page=0&size=20&sort=title`")
            @PageableDefault(size = 20, sort = "title") Pageable pageable) {
        return ResponseEntity.ok(bookService.findAll(pageable));
    }

    @Operation(summary = "Get book by ID (admin view)", description = "Returns a single book by UUID. Admin-only.")
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Book found"),
        @ApiResponse(responseCode = "403", description = "Insufficient role — admin required"),
        @ApiResponse(responseCode = "404", description = "Book not found"),
    })
    @GetMapping("/{id}")
    public ResponseEntity<Book> getBook(
            @Parameter(description = "Book UUID") @PathVariable UUID id) {
        return ResponseEntity.ok(bookService.findById(id));
    }

    @Operation(
        summary = "Create book",
        description = "Creates a new book in the catalog. A corresponding inventory record must be created separately in the Inventory Service."
    )
    @ApiResponses({
        @ApiResponse(responseCode = "201", description = "Book created — Location header points to new resource"),
        @ApiResponse(responseCode = "400", description = "Validation error",
            content = @Content(schema = @Schema(example = "{\"status\":400,\"detail\":\"Title is required\"}"))),
        @ApiResponse(responseCode = "403", description = "Insufficient role — admin required"),
    })
    @PostMapping
    public ResponseEntity<Book> createBook(@Valid @RequestBody BookRequest request) {
        Book created = bookService.create(request);
        URI location = ServletUriComponentsBuilder.fromCurrentRequest()
            .path("/{id}")
            .buildAndExpand(created.getId())
            .toUri();
        return ResponseEntity.created(location).body(created);
    }

    @Operation(summary = "Update book", description = "Replaces all fields of an existing book. All required fields must be provided.")
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Book updated"),
        @ApiResponse(responseCode = "400", description = "Validation error"),
        @ApiResponse(responseCode = "403", description = "Insufficient role — admin required"),
        @ApiResponse(responseCode = "404", description = "Book not found"),
    })
    @PutMapping("/{id}")
    public ResponseEntity<Book> updateBook(
            @Parameter(description = "Book UUID") @PathVariable UUID id,
            @Valid @RequestBody BookRequest request) {
        return ResponseEntity.ok(bookService.update(id, request));
    }

    @Operation(
        summary = "Delete book",
        description = "Permanently removes a book from the catalog. "
            + "**Warning:** existing order records referencing this book will have a dangling FK. "
            + "Only delete books that have no associated orders."
    )
    @ApiResponses({
        @ApiResponse(responseCode = "204", description = "Book deleted"),
        @ApiResponse(responseCode = "403", description = "Insufficient role — admin required"),
        @ApiResponse(responseCode = "404", description = "Book not found"),
    })
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteBook(
            @Parameter(description = "Book UUID") @PathVariable UUID id) {
        bookService.delete(id);
        return ResponseEntity.noContent().build();
    }
}
