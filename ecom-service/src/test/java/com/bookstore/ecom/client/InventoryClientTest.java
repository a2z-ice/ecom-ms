package com.bookstore.ecom.client;

import com.bookstore.ecom.dto.InventoryReserveRequest;
import com.bookstore.ecom.dto.InventoryReserveResponse;
import com.bookstore.ecom.exception.BusinessException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClient.RequestBodyUriSpec;
import org.springframework.web.client.RestClient.RequestBodySpec;
import org.springframework.web.client.RestClient.ResponseSpec;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

class InventoryClientTest {

    private RestClient restClient;
    private RequestBodyUriSpec requestBodyUriSpec;
    private RequestBodySpec requestBodySpec;
    private ResponseSpec responseSpec;
    private InventoryClient inventoryClient;

    @BeforeEach
    void setUp() {
        restClient = mock(RestClient.class);
        requestBodyUriSpec = mock(RequestBodyUriSpec.class);
        requestBodySpec = mock(RequestBodySpec.class);
        responseSpec = mock(ResponseSpec.class);

        when(restClient.post()).thenReturn(requestBodyUriSpec);
        when(requestBodyUriSpec.uri(eq("/inven/stock/reserve"))).thenReturn(requestBodySpec);
        when(requestBodySpec.contentType(eq(MediaType.APPLICATION_JSON))).thenReturn(requestBodySpec);
        when(requestBodySpec.body(any(InventoryReserveRequest.class))).thenReturn(requestBodySpec);
        when(requestBodySpec.retrieve()).thenReturn(responseSpec);

        inventoryClient = new InventoryClient(restClient);
    }

    @Test
    @DisplayName("Successful reserve call returns response")
    void reserve_success() {
        UUID bookId = UUID.randomUUID();
        var expected = new InventoryReserveResponse(bookId, 2, 8);
        when(responseSpec.body(InventoryReserveResponse.class)).thenReturn(expected);

        InventoryReserveResponse result = inventoryClient.reserve(bookId, 2);

        assertThat(result).isEqualTo(expected);
        assertThat(result.book_id()).isEqualTo(bookId);
        assertThat(result.quantity_reserved()).isEqualTo(2);
        assertThat(result.remaining_available()).isEqualTo(8);
    }

    @Test
    @DisplayName("Circuit breaker opens after repeated failures — 100% failure rate over sliding window of 10")
    void circuitBreaker_opensAfterFailures() {
        // CircuitBreaker config: slidingWindowSize=10, failureRateThreshold=50%.
        // All 10 calls fail with a generic RuntimeException (e.g. connection refused).
        when(responseSpec.body(InventoryReserveResponse.class))
            .thenThrow(new RuntimeException("Connection refused"));

        UUID bookId = UUID.randomUUID();

        // Fill the sliding window with 10 failures
        for (int i = 0; i < 10; i++) {
            try {
                inventoryClient.reserve(bookId, 1);
            } catch (BusinessException e) {
                // Expected — RuntimeException is caught by the generic handler and wrapped
            }
        }

        // 11th call: circuit is OPEN, so CallNotPermittedException is thrown
        // and translated to "Inventory service temporarily unavailable"
        assertThatThrownBy(() -> inventoryClient.reserve(bookId, 1))
            .isInstanceOf(BusinessException.class)
            .hasMessage("Inventory service temporarily unavailable");
    }

    @Test
    @DisplayName("When circuit is open, RestClient is not invoked at all")
    void reserve_circuitOpen_doesNotCallRestClient() {
        // Trip the circuit breaker with 10 failures
        when(responseSpec.body(InventoryReserveResponse.class))
            .thenThrow(new RuntimeException("timeout"));

        UUID bookId = UUID.randomUUID();

        for (int i = 0; i < 10; i++) {
            try {
                inventoryClient.reserve(bookId, 1);
            } catch (BusinessException e) {
                // expected
            }
        }

        // Reset the mock so we can verify no new interactions after the circuit opens
        reset(restClient);

        assertThatThrownBy(() -> inventoryClient.reserve(bookId, 1))
            .isInstanceOf(BusinessException.class)
            .hasMessage("Inventory service temporarily unavailable");

        // RestClient should not have been called — circuit is open
        verifyNoInteractions(restClient);
    }

    @Test
    @DisplayName("409 Conflict (insufficient stock) returns BusinessException with descriptive message")
    void reserve_409_throwsBusinessExceptionInsufficientStock() {
        UUID bookId = UUID.randomUUID();

        // HttpClientErrorException with 409 is caught in doReserve and re-thrown as BusinessException.
        // Note: since the circuit breaker has no ignoreExceptions configured, this exception
        // IS counted as a failure. Repeated 409s will eventually open the circuit.
        HttpClientErrorException conflict = HttpClientErrorException.create(
            HttpStatusCode.valueOf(409), "Conflict", null, null, null);
        when(requestBodySpec.retrieve()).thenThrow(conflict);

        assertThatThrownBy(() -> inventoryClient.reserve(bookId, 1))
            .isInstanceOf(BusinessException.class)
            .hasMessageContaining("Insufficient stock for book")
            .hasMessageContaining(bookId.toString());
    }

    @Test
    @DisplayName("409 errors trip the circuit breaker (no ignoreExceptions configured)")
    void reserve_409_doesTripCircuitBreaker() {
        UUID bookId = UUID.randomUUID();

        // Set up 409 response for all calls
        HttpClientErrorException conflict = HttpClientErrorException.create(
            HttpStatusCode.valueOf(409), "Conflict", null, null, null);
        when(requestBodySpec.retrieve()).thenThrow(conflict);

        // Make 10 calls that all get 409 (BusinessException counts as failure)
        for (int i = 0; i < 10; i++) {
            try {
                inventoryClient.reserve(bookId, 1);
            } catch (BusinessException e) {
                // expected — "Insufficient stock..."
            }
        }

        // Circuit should now be OPEN. The 11th call should fail with
        // "temporarily unavailable" (CallNotPermittedException) instead of "Insufficient stock"
        assertThatThrownBy(() -> inventoryClient.reserve(bookId, 1))
            .isInstanceOf(BusinessException.class)
            .hasMessage("Inventory service temporarily unavailable");
    }

    @Test
    @DisplayName("404 Not Found throws BusinessException with book ID")
    void reserve_404_throwsBusinessException() {
        UUID bookId = UUID.randomUUID();
        HttpClientErrorException notFound = HttpClientErrorException.create(
            HttpStatusCode.valueOf(404), "Not Found", null, null, null);
        when(requestBodySpec.retrieve()).thenThrow(notFound);

        assertThatThrownBy(() -> inventoryClient.reserve(bookId, 1))
            .isInstanceOf(BusinessException.class)
            .hasMessageContaining("Book not found in inventory")
            .hasMessageContaining(bookId.toString());
    }

    @Test
    @DisplayName("Generic server error throws wrapped BusinessException")
    void reserve_500_throwsWrappedBusinessException() {
        UUID bookId = UUID.randomUUID();
        when(responseSpec.body(InventoryReserveResponse.class))
            .thenThrow(new RuntimeException("Internal Server Error"));

        assertThatThrownBy(() -> inventoryClient.reserve(bookId, 1))
            .isInstanceOf(BusinessException.class)
            .hasMessage("Inventory service unavailable");
    }
}
