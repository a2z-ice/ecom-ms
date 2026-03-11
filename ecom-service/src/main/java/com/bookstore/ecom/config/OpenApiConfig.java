package com.bookstore.ecom.config;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.info.License;
import io.swagger.v3.oas.models.security.SecurityScheme;
import io.swagger.v3.oas.models.servers.Server;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;

@Configuration
public class OpenApiConfig {

    @Bean
    public OpenAPI customOpenAPI() {
        return new OpenAPI()
            .info(new Info()
                .title("BookStore E-Commerce API")
                .version("1.0.0")
                .description("""
                    ## BookStore E-Commerce Service

                    REST API for book catalog browsing, shopping cart management, and order checkout.

                    ### Authentication
                    Protected endpoints require a **Bearer JWT** token issued by Keycloak.

                    **How to get a token:**
                    1. Open the UI at `https://localhost:30000` and log in (user1 / CHANGE_ME)
                    2. Open DevTools → Application → Session Storage → copy the OIDC user JSON
                    3. Extract the `access_token` field
                    4. Click **Authorize** above, enter: `Bearer <your_access_token>`

                    **Or via curl:**
                    ```
                    TOKEN=$(curl -s -X POST https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token \\
                      -d "grant_type=password&client_id=ui-client&username=user1&password=CHANGE_ME" \\
                      -H "Content-Type: application/x-www-form-urlencoded" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
                    ```

                    ### Public Endpoints (no auth)
                    - `GET /books` — paginated book catalog
                    - `GET /books/search` — full-text search
                    - `GET /books/{id}` — single book details

                    ### Protected Endpoints (Bearer JWT required)
                    - `GET /cart`, `POST /cart`, `PUT /cart/{itemId}`, `DELETE /cart/{itemId}`
                    - `POST /checkout`
                    """)
                .contact(new Contact()
                    .name("BookStore Platform")
                    .email("platform@bookstore.local"))
                .license(new License()
                    .name("MIT License")
                    .url("https://opensource.org/licenses/MIT")))
            .servers(List.of(
                new Server()
                    .url("https://api.service.net:30000/ecom")
                    .description("Kind cluster — Istio Gateway NodePort (external)"),
                new Server()
                    .url("http://ecom-service.ecom.svc.cluster.local:8080/ecom")
                    .description("Kubernetes cluster-internal URL")))
            .components(new Components()
                .addSecuritySchemes("BearerAuth", new SecurityScheme()
                    .type(SecurityScheme.Type.HTTP)
                    .scheme("bearer")
                    .bearerFormat("JWT")
                    .description("Keycloak JWT access token. Obtain via OIDC login at https://localhost:30000")));
    }
}
