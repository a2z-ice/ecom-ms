package com.bookstore.ecom.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import java.math.BigDecimal;

@Schema(description = "Request body for creating or updating a book")
public record BookRequest(

    @Schema(description = "Book title", example = "The Hobbit")
    @NotBlank(message = "Title is required")
    String title,

    @Schema(description = "Author name", example = "J.R.R. Tolkien")
    @NotBlank(message = "Author is required")
    String author,

    @Schema(description = "Price in USD", example = "12.99")
    @NotNull(message = "Price is required")
    @DecimalMin(value = "0.01", message = "Price must be greater than 0")
    BigDecimal price,

    @Schema(description = "Book description (optional)")
    String description,

    @Schema(description = "Cover image URL (optional)")
    String coverUrl,

    @Schema(description = "ISBN-13 (optional)", example = "978-0-618-00221-3")
    String isbn,

    @Schema(description = "Genre (optional)", example = "Fantasy")
    String genre,

    @Schema(description = "Year of publication (optional)", example = "1937")
    Integer publishedYear

) {}
