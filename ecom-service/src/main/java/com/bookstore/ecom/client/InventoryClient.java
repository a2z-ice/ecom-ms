package com.bookstore.ecom.client;

import com.bookstore.ecom.dto.InventoryReserveRequest;
import com.bookstore.ecom.dto.InventoryReserveResponse;
import com.bookstore.ecom.exception.BusinessException;
import io.github.resilience4j.circuitbreaker.CallNotPermittedException;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerConfig;
import io.github.resilience4j.circuitbreaker.CircuitBreakerRegistry;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;

import java.time.Duration;
import java.util.UUID;

/**
 * HTTP client for inventory-service.
 *
 * Calls are made pod-to-pod via Istio Ambient Mesh ztunnel, which automatically
 * establishes mTLS using the pod's SPIFFE identity:
 *   cluster.local/ns/ecom/sa/ecom-service
 *
 * The inventory-service AuthorizationPolicy allows POST /inven/stock/reserve
 * only from this principal — external callers without the ecom-service SA
 * certificate receive a 403 RBAC denied response from Istio.
 *
 * A Resilience4j circuit breaker protects against cascading failures when
 * the inventory service is down or degraded.
 */
@Component
@Slf4j
public class InventoryClient {

    private final RestClient inventoryRestClient;
    private final CircuitBreaker circuitBreaker;

    public InventoryClient(RestClient inventoryRestClient) {
        this.inventoryRestClient = inventoryRestClient;

        CircuitBreakerConfig config = CircuitBreakerConfig.custom()
            .slidingWindowSize(10)
            .failureRateThreshold(50)
            .waitDurationInOpenState(Duration.ofSeconds(10))
            .permittedNumberOfCallsInHalfOpenState(3)
            .build();
        CircuitBreakerRegistry registry = CircuitBreakerRegistry.of(config);
        this.circuitBreaker = registry.circuitBreaker("inventoryService");
    }

    public InventoryReserveResponse reserve(UUID bookId, int quantity) {
        try {
            return circuitBreaker.executeSupplier(() -> doReserve(bookId, quantity));
        } catch (CallNotPermittedException e) {
            log.warn("Circuit breaker OPEN for inventory service, bookId={}", bookId);
            throw new BusinessException("Inventory service temporarily unavailable");
        } catch (BusinessException e) {
            // Re-throw business exceptions (insufficient stock, not found) without wrapping
            throw e;
        } catch (Exception e) {
            log.error("Inventory reserve failed bookId={}: {}", bookId, e.getMessage());
            throw new BusinessException("Inventory service unavailable");
        }
    }

    private InventoryReserveResponse doReserve(UUID bookId, int quantity) {
        try {
            // InventoryReserveRequest uses snake_case field 'book_id' matching FastAPI schema
            return inventoryRestClient.post()
                .uri("/inven/stock/reserve")
                .contentType(MediaType.APPLICATION_JSON)
                .body(new InventoryReserveRequest(bookId, quantity))
                .retrieve()
                .body(InventoryReserveResponse.class);
        } catch (HttpClientErrorException e) {
            int status = e.getStatusCode().value();
            if (status == 409) {
                log.warn("Insufficient stock bookId={} qty={}", bookId, quantity);
                throw new BusinessException("Insufficient stock for book: " + bookId);
            } else if (status == 404) {
                log.warn("Book not found in inventory bookId={}", bookId);
                throw new BusinessException("Book not found in inventory: " + bookId);
            }
            log.error("Inventory reserve failed bookId={} status={}: {}", bookId, status, e.getMessage());
            throw new BusinessException("Inventory service error");
        }
    }
}
