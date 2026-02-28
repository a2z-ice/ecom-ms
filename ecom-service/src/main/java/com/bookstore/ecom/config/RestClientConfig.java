package com.bookstore.ecom.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

import java.net.http.HttpClient;

@Configuration
public class RestClientConfig {

    @Bean
    public RestClient inventoryRestClient(@Value("${INVENTORY_SERVICE_URL}") String baseUrl) {
        // Force HTTP/1.1 to avoid h2c upgrade headers that Starlette/uvicorn's h11 parser rejects.
        // Java's default HttpClient may send Connection:Upgrade/Upgrade:h2c headers which cause
        // 400 "Invalid HTTP request received" from FastAPI when running over plain HTTP.
        var httpClient = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .build();
        return RestClient.builder()
            .baseUrl(baseUrl)
            .requestFactory(new JdkClientHttpRequestFactory(httpClient))
            .build();
    }
}
