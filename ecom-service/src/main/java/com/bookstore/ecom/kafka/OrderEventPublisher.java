package com.bookstore.ecom.kafka;

import com.bookstore.ecom.dto.OrderCreatedEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
@Slf4j
public class OrderEventPublisher {

    private final KafkaTemplate<String, Object> kafkaTemplate;

    @Value("${kafka.topics.order-created:order.created}")
    private String orderCreatedTopic;

    public void publishOrderCreated(OrderCreatedEvent event) {
        kafkaTemplate.send(orderCreatedTopic, event.orderId().toString(), event)
            .whenComplete((result, ex) -> {
                if (ex != null) {
                    log.error("Failed to publish order.created event for orderId={}", event.orderId(), ex);
                } else {
                    log.info("Published order.created event: orderId={} offset={}",
                        event.orderId(),
                        result.getRecordMetadata().offset());
                }
            });
    }
}
