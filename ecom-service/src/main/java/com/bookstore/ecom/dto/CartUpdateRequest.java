package com.bookstore.ecom.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;

public record CartUpdateRequest(
    @Min(1) @Max(99) int quantity
) {}
