package com.bookstore.ecom.integration;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.RestClient;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.ResultSet;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
@ActiveProfiles("test")
class BookApiIntegrationTest {

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
    private DataSource dataSource;

    private RestClient restClient() {
        return RestClient.create("http://localhost:" + port);
    }

    @Test
    @DisplayName("GET /ecom/books returns 200 with seeded books from Liquibase")
    void listBooks_returnsSeededBooks() {
        var response = restClient().get().uri("/ecom/books").retrieve().toEntity(Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().get("totalElements")).isEqualTo(10);
    }

    @Test
    @DisplayName("GET /ecom/books/search?q=Java returns matching results")
    void searchBooks_returnsMatches() {
        var response = restClient().get().uri("/ecom/books/search?q=Java").retrieve().toEntity(Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
        var content = (java.util.List<?>) response.getBody().get("content");
        assertThat(content).isNotEmpty();
    }

    @Test
    @DisplayName("GET /ecom/books/{id} returns specific book by UUID")
    void getBook_returnsSpecificBook() {
        var response = restClient().get().uri("/ecom/books/00000000-0000-0000-0000-000000000001")
                .retrieve().toEntity(Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().get("id")).isEqualTo("00000000-0000-0000-0000-000000000001");
    }

    @Test
    @DisplayName("GET /ecom/books response has Cache-Control header")
    void listBooks_hasCacheControlHeader() {
        var response = restClient().get().uri("/ecom/books").retrieve().toEntity(Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getHeaders().getCacheControl()).isEqualTo("max-age=60, public");
    }

    @Test
    @DisplayName("GET /ecom/books/search response has Cache-Control header")
    void searchBooks_hasCacheControlHeader() {
        var response = restClient().get().uri("/ecom/books/search?q=test").retrieve().toEntity(Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getHeaders().getCacheControl()).isEqualTo("max-age=60, public");
    }

    @Test
    @DisplayName("Liquibase migrations created the books table")
    void liquibaseMigrations_createdBooksTable() throws Exception {
        try (Connection conn = dataSource.getConnection()) {
            ResultSet rs = conn.getMetaData().getTables(null, "public", "books", null);
            assertThat(rs.next()).isTrue();
        }
    }

    @Test
    @DisplayName("Liquibase migrations created the cart_items table")
    void liquibaseMigrations_createdCartItemsTable() throws Exception {
        try (Connection conn = dataSource.getConnection()) {
            ResultSet rs = conn.getMetaData().getTables(null, "public", "cart_items", null);
            assertThat(rs.next()).isTrue();
        }
    }

    @Test
    @DisplayName("Liquibase migrations created the orders table")
    void liquibaseMigrations_createdOrdersTable() throws Exception {
        try (Connection conn = dataSource.getConnection()) {
            ResultSet rs = conn.getMetaData().getTables(null, "public", "orders", null);
            assertThat(rs.next()).isTrue();
        }
    }

    @Test
    @DisplayName("GET /ecom/books supports pagination parameters")
    void listBooks_supportsPagination() {
        var response = restClient().get().uri("/ecom/books?page=0&size=3").retrieve().toEntity(Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
        var content = (java.util.List<?>) response.getBody().get("content");
        assertThat(content).hasSize(3);
        assertThat(response.getBody().get("totalElements")).isEqualTo(10);
    }

    @Test
    @DisplayName("GET /ecom/books/search with no matches returns empty page")
    void searchBooks_noMatches_returnsEmptyPage() {
        var response = restClient().get().uri("/ecom/books/search?q=xyznonexistent123").retrieve().toEntity(Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
        var content = (java.util.List<?>) response.getBody().get("content");
        assertThat(content).isEmpty();
        assertThat(response.getBody().get("totalElements")).isEqualTo(0);
    }
}
