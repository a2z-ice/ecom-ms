package com.bookstore.ecom.kafka;

import com.bookstore.ecom.model.OutboxEvent;
import com.bookstore.ecom.repository.OutboxEventRepository;
import tools.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * Polls the outbox_events table for unpublished events and sends them to Kafka.
 * Runs every second. Events are marked as published after successful send.
 */
@Component
@EnableScheduling
@RequiredArgsConstructor
@Slf4j
public class OutboxPublisher {

    private final OutboxEventRepository outboxRepo;
    private final KafkaTemplate<String, Object> kafkaTemplate;
    private final ObjectMapper objectMapper;

    @Value("${kafka.topics.order-created:order.created}")
    private String orderCreatedTopic;

    @Scheduled(fixedDelay = 1000)
    @Transactional
    public void publishPendingEvents() {
        List<OutboxEvent> events = outboxRepo.findByPublishedAtIsNullOrderByCreatedAtAsc();
        for (OutboxEvent event : events) {
            try {
                String topic = resolveTopicForEventType(event.getEventType());
                Object payload = objectMapper.readValue(event.getPayload(), Object.class);
                kafkaTemplate.send(topic, event.getAggregateId(), payload).get();
                event.setPublishedAt(OffsetDateTime.now());
                outboxRepo.save(event);
                log.info("Outbox published: type={} aggregateId={}", event.getEventType(), event.getAggregateId());
            } catch (Exception ex) {
                log.warn("Outbox publish failed for event={}, will retry: {}", event.getId(), ex.getMessage());
                break;
            }
        }
    }

    private String resolveTopicForEventType(String eventType) {
        return switch (eventType) {
            case "order.created" -> orderCreatedTopic;
            default -> throw new IllegalArgumentException("Unknown event type: " + eventType);
        };
    }
}
