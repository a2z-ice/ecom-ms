package com.bookstore.ecom.integration;

import com.bookstore.ecom.repository.CartItemRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.web.client.RestClient;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
@ActiveProfiles("test")
class CartIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine")
            .withDatabaseName("ecom_test")
            .withUsername("test")
            .withPassword("test");

    @DynamicPropertySource
    static void overrideProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
        registry.add("spring.kafka.bootstrap-servers", () -> "localhost:9999");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwks-uri",
                () -> "http://localhost:0/not-used");
        registry.add("KEYCLOAK_JWKS_URI", () -> "http://localhost:0/not-used");
        registry.add("KEYCLOAK_ISSUER_URI", () -> "http://localhost:0/test-issuer");
        registry.add("INVENTORY_SERVICE_URL", () -> "http://localhost:0");
        registry.add("spring.data.redis.host", () -> "localhost");
        registry.add("spring.data.redis.port", () -> "6379");
        registry.add("spring.data.redis.password", () -> "unused");
    }

    @LocalServerPort
    private int port;

    @Autowired
    private CartItemRepository cartItemRepository;

    @MockitoBean
    private JwtDecoder jwtDecoder;

    private static final String BOOK_ID_1 = "00000000-0000-0000-0000-000000000001";
    private static final String BOOK_ID_2 = "00000000-0000-0000-0000-000000000002";
    private static final String USER_ID = "test-user-abc";
    private static final String FAKE_TOKEN = "fake-jwt-token";

    private RestClient restClient() {
        return RestClient.create("http://localhost:" + port);
    }

    @BeforeEach
    void setUp() {
        cartItemRepository.deleteAll();
    }

    private void mockJwtForUser(String userId) {
        Jwt jwt = Jwt.withTokenValue(FAKE_TOKEN)
                .header("alg", "RS256")
                .claim("sub", userId)
                .claim("roles", List.of("customer"))
                .issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600))
                .build();
        when(jwtDecoder.decode(anyString())).thenReturn(jwt);
    }

    @Test
    @DisplayName("GET /ecom/cart without JWT returns 401")
    void getCart_noAuth_returns401() {
        try {
            restClient().get().uri("/ecom/cart").retrieve().toEntity(Map.class);
            assertThat(false).as("Expected 401").isTrue();
        } catch (org.springframework.web.client.HttpClientErrorException e) {
            assertThat(e.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        }
    }

    @Test
    @DisplayName("GET /ecom/cart with JWT returns empty cart initially")
    void getCart_authenticated_returnsEmptyCart() {
        mockJwtForUser("empty-cart-user");
        var response = restClient().get().uri("/ecom/cart")
                .header("Authorization", "Bearer " + FAKE_TOKEN)
                .retrieve().toEntity(List.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isEmpty();
    }

    @Test
    @DisplayName("POST /ecom/cart adds item to cart and returns it")
    void addToCart_addsItemSuccessfully() {
        mockJwtForUser(USER_ID);
        String body = """
                {"bookId": "%s", "quantity": 2}
                """.formatted(BOOK_ID_1);

        var response = restClient().post().uri("/ecom/cart")
                .header("Authorization", "Bearer " + FAKE_TOKEN)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve().toEntity(Map.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
        assertThat(((Map<?, ?>) response.getBody().get("book")).get("id")).isEqualTo(BOOK_ID_1);
        assertThat(response.getBody().get("quantity")).isEqualTo(2);
        assertThat(response.getBody().get("userId")).isEqualTo(USER_ID);
    }

    @Test
    @DisplayName("POST /ecom/cart twice with same book increments quantity")
    void addToCart_sameBookTwice_incrementsQuantity() {
        mockJwtForUser("increment-user");
        String body = """
                {"bookId": "%s", "quantity": 1}
                """.formatted(BOOK_ID_2);

        var first = restClient().post().uri("/ecom/cart")
                .header("Authorization", "Bearer " + FAKE_TOKEN)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve().toEntity(Map.class);
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(first.getBody().get("quantity")).isEqualTo(1);

        var second = restClient().post().uri("/ecom/cart")
                .header("Authorization", "Bearer " + FAKE_TOKEN)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve().toEntity(Map.class);
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(second.getBody().get("quantity")).isEqualTo(2);
    }

    @Test
    @DisplayName("POST /ecom/cart with nonexistent book returns 404")
    void addToCart_unknownBook_returns404() {
        mockJwtForUser("any-user");
        String body = """
                {"bookId": "99999999-9999-9999-9999-999999999999", "quantity": 1}
                """;
        try {
            restClient().post().uri("/ecom/cart")
                    .header("Authorization", "Bearer " + FAKE_TOKEN)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .retrieve().toEntity(Map.class);
            assertThat(false).as("Expected 404").isTrue();
        } catch (org.springframework.web.client.HttpClientErrorException e) {
            assertThat(e.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        }
    }

    @Test
    @DisplayName("GET /ecom/cart returns items with nested book details")
    void getCart_returnsItemsWithBookDetails() {
        mockJwtForUser("details-user");
        String body = """
                {"bookId": "%s", "quantity": 1}
                """.formatted(BOOK_ID_1);

        restClient().post().uri("/ecom/cart")
                .header("Authorization", "Bearer " + FAKE_TOKEN)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve().toEntity(Map.class);

        var response = restClient().get().uri("/ecom/cart")
                .header("Authorization", "Bearer " + FAKE_TOKEN)
                .retrieve().toEntity(List.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).hasSize(1);

        @SuppressWarnings("unchecked")
        Map<String, Object> firstItem = (Map<String, Object>) response.getBody().get(0);
        @SuppressWarnings("unchecked")
        Map<String, Object> book = (Map<String, Object>) firstItem.get("book");
        assertThat(book.get("id")).isEqualTo(BOOK_ID_1);
        assertThat(book.get("title")).isNotNull();
    }
}
