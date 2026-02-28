package com.bookstore.ecom.dto;

import jakarta.validation.constraints.Min;

public record CartUpdateRequest(
    @Min(1) int quantity
) {}
