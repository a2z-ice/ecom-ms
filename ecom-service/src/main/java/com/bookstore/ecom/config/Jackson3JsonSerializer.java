package com.bookstore.ecom.config;

import org.apache.kafka.common.serialization.Serializer;
import tools.jackson.databind.ObjectMapper;

/**
 * Kafka value serializer compatible with Jackson 3.x (Spring Boot 4 / Spring Boot 7).
 * Spring Kafka's built-in JsonSerializer depends on Jackson 2.x (com.fasterxml.jackson.*),
 * but Spring Boot 4.0 ships Jackson 3.x (tools.jackson.*) which moved package namespaces.
 */
public class Jackson3JsonSerializer implements Serializer<Object> {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public byte[] serialize(String topic, Object data) {
        if (data == null) return null;
        try {
            return MAPPER.writeValueAsBytes(data);
        } catch (Exception e) {
            throw new RuntimeException("Failed to serialize Kafka message to JSON for topic: " + topic, e);
        }
    }
}
