# E-Commerce Promotion Event System

## Kafka + Long-Running Rust Consumer Architecture Plan

------------------------------------------------------------------------

## 1. Overview

This document defines the enterprise-scale architecture for implementing
the Promotion Event Calendar and Notification Dispatch system using:

-   Event-Driven Architecture
-   CDC for change propagation
-   Kafka for domain event streaming
-   Long-running Rust Kafka consumer (NOT Knative)
-   Spring Boot for domain services
-   React frontend

This design removes serverless orchestration complexity and optimizes
for:

-   Massive fan-out
-   Predictable daily dispatch
-   High throughput
-   Reliability
-   Observability
-   Operational simplicity

------------------------------------------------------------------------

## 2. Existing Services

-   E-commerce Service --- Spring Boot
-   Inventory Service --- FastAPI
-   Identity Provider --- Keycloak
-   Frontend --- React
-   CDC already implemented

------------------------------------------------------------------------

## 3. New Components

### 3.1 Event Calendar Service (Spring Boot)

Responsibilities:

-   Create / Edit / Delete promotion events
-   Draft → Publish lifecycle
-   Own dedicated database
-   Expose Admin REST APIs

Event Fields:

-   event_id (UUID)
-   title
-   description
-   promotion_package
-   start_datetime
-   end_datetime
-   status (DRAFT / PUBLISHED / EXPIRED)
-   created_at
-   updated_at

Publishing changes status to PUBLISHED.

No direct REST call to Notification service.

------------------------------------------------------------------------

## 4. CDC → Kafka Integration

CDC monitors Event DB.

When event status transitions to PUBLISHED:

Publish to Kafka topic:

promotion.events

Payload:

-   event_id
-   start_datetime
-   end_datetime
-   promotion_package

------------------------------------------------------------------------

## 5. Promotion Scheduler Service

Lightweight Rust/Springboot durable scheduler using restate or Kafka Streams application (choose the best option).

Responsibilities:

-   Consume promotion.events
-   Monitor active event time windows
-   Trigger daily dispatch events
-   Publish to Kafka topic:

promotion.dispatch

Dispatch Payload:

-   event_id
-   dispatch_date

------------------------------------------------------------------------

## 6. Rust Notification Dispatcher (Long-Running Service)

Technology: Rust (rdkafka recommended)

Deployment Model:

-   Standard Kubernetes Deployment
-   NOT Knative
-   Horizontal Pod Autoscaler (HPA)
-   Long-running Kafka consumer group

Responsibilities:

-   Consume promotion.dispatch
-   Partition-based workload distribution
-   Fetch eligible users in batches
-   Insert messages into Notification DB
-   Ensure idempotency
-   Commit Kafka offsets only after successful processing

------------------------------------------------------------------------

## 7. Notification Database Schema

Message Table:

-   message_id (UUID)
-   user_id
-   event_id
-   dispatch_date
-   content
-   is_read (boolean)
-   created_at

Unique Constraint:

UNIQUE (user_id, event_id, dispatch_date)

This guarantees idempotent message creation.

------------------------------------------------------------------------

## 8. Kafka Topic Design

Topics:

-   promotion.events
-   promotion.dispatch

Partition Strategy:

promotion.events → partition by event_id\
promotion.dispatch → partition by user_id

For 10M+ users:

-   50--100 partitions
-   Multiple Rust consumer instances
-   Automatic workload balancing

------------------------------------------------------------------------

## 9. End-to-End Flow

1.  Admin publishes event
2.  Event stored in Event DB
3.  CDC publishes to Kafka (promotion.events)
4.  Scheduler consumes event and monitors window
5.  Scheduler publishes daily dispatch event (promotion.dispatch)
6.  Rust consumer group processes partitions
7.  Messages inserted into Notification DB
8.  Customer logs in
9.  Inbox displays unread count

------------------------------------------------------------------------

## 10. Frontend Enhancements

### Admin UI

Route:

/admin/event-calendar

Features:

-   Calendar visualization
-   Draft / Publish control
-   Professional interval marking

### Customer UI

Inbox Menu:

-   Positioned left of Logout button
-   Unread badge counter
-   Paginated inbox view
-   Mark as read functionality

REST APIs:

GET /messages\
GET /messages/unread-count\
PUT /messages/{id}/read

------------------------------------------------------------------------

## 11. Scalability Model

Rust Consumer Scaling:

-   Consumer group scaling via Kubernetes replicas
-   Each replica processes assigned Kafka partitions
-   Backpressure managed natively by Kafka
-   Offset commit ensures reliability

Database Optimization:

-   Index on user_id
-   Index on (user_id, is_read)
-   Maintain unread counter
-   Optional Redis cache

------------------------------------------------------------------------

## 12. Reliability & Fault Tolerance

-   Kafka offset-based processing
-   Dead-letter topic
-   Retry with exponential backoff
-   Idempotent writes
-   Consumer restart safety
-   Event replay capability via offset reset

------------------------------------------------------------------------

## 13. Security Model

-   Keycloak role-based access
-   JWT validation in services
-   Kafka ACLs
-   Network policy isolation
-   Service-to-service authentication

------------------------------------------------------------------------

## 14. Why Not Knative

This workload is:

-   Predictable
-   Daily
-   High fan-out
-   Stateful

Long-running Rust consumer is preferred because:

-   No cold starts
-   Native Kafka backpressure
-   Offset-based reliability
-   Simpler operational model
-   Better suited for large-scale message distribution

------------------------------------------------------------------------

## 15. Architectural Benefits

-   Fully event-driven
-   Loose coupling
-   High throughput
-   Horizontal scaling
-   Strong consistency
-   Replay capability
-   Production-grade reliability

------------------------------------------------------------------------

## 16. Final Architecture Flow

Admin (React) ↓ Event Calendar Service ↓ Event DB ↓ CDC ↓ Kafka
(promotion.events) ↓ Promotion Scheduler Service ↓ Kafka
(promotion.dispatch) ↓ Rust Kafka Consumer Group (Kubernetes Deployment)
↓ Notification Database ↓ React Inbox (REST)

No synchronous REST between domain services.

------------------------------------------------------------------------

## 17. Conclusion

This architecture uses Kafka as the central event backbone and Rust as a
high-performance, long-running consumer service. It removes serverless
complexity while maintaining scalability, reliability, and operational
clarity suitable for millions of users and enterprise-grade workloads.
