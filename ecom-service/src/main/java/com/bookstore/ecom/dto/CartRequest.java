package com.bookstore.ecom.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;

import java.util.UUID;

public record CartRequest(
    @NotNull UUID bookId,
    @Min(1) @Max(99) int quantity
) {}
