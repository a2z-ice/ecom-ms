# E-commerce Application Enhancement Plan

## Event Calendar & Promotion Notification Architecture

## 1. Overview

This document describes the architectural enhancement of the existing
e-commerce microservices platform to introduce an **Admin-Driven Event
Calendar and Promotion Notification System**.

The enhancement introduces:

-   Admin-managed promotion event calendar
-   Time-bound promotion lifecycle
-   Scheduled daily promotion notification delivery
-   User inbox with unread count indicator
-   Dedicated message microservice
-   Flink-triggered Knative Rust job execution
-   Strict microservice boundaries with REST integration

This design ensures scalability, separation of concerns, observability,
and maintainability.

------------------------------------------------------------------------

## 2. Current Architecture (Baseline)

### Existing Microservices

1.  E-commerce Service
    -   Backend: Spring Boot
    -   Frontend: React
    -   Handles product browsing, ordering, user interaction
2.  Inventory Service
    -   Backend: Python FastAPI
    -   Manages product stock and availability
3.  Identity Provider
    -   Keycloak
    -   Role-based access control (Admin / Customer)

------------------------------------------------------------------------

## 3. New Components to Introduce

### 3.1 Event Calendar Microservice (NEW)

Technology: Spring Boot\
Database: Dedicated relational database (PostgreSQL recommended)

Responsibilities:

-   Create, edit, delete promotion events
-   Draft and Publish workflow
-   Store promotion metadata
-   Expose REST APIs
-   Trigger promotion workflow upon publish

Key Fields:

-   event_id (UUID)
-   title
-   description
-   promotion_package
-   start_datetime
-   end_datetime
-   status (DRAFT / PUBLISHED / EXPIRED)
-   created_by
-   created_at
-   updated_at

Workflow:

1.  Admin creates event → Status = DRAFT
2.  Admin publishes event → Status = PUBLISHED
3.  Event becomes active only at start_datetime

------------------------------------------------------------------------

### 3.2 Message & Notification Microservice (NEW)

Technology: Spring Boot\
Database: Dedicated database

Responsibilities:

-   Store user messages
-   Track read/unread status
-   Expose inbox APIs
-   Maintain message history

Key Fields:

-   message_id (UUID)
-   user_id
-   event_id
-   subject
-   content
-   is_read (boolean)
-   created_at

APIs:

-   GET /messages (paginated)
-   GET /messages/unread-count
-   PUT /messages/{id}/read

------------------------------------------------------------------------

### 3.3 Flink Scheduled Job

Purpose:

-   Monitor active published events
-   Trigger daily message dispatch within configured interval

Behavior:

-   Job runs continuously
-   Validates:
    -   Current time \>= start_datetime
    -   Current time \<= end_datetime
-   Executes once per day per active event

------------------------------------------------------------------------

### 3.4 Knative Rust Job

Trigger: Apache Flink

Responsibilities:

-   Fetch eligible users
-   Generate promotion message
-   Call Message Microservice REST API
-   Ensure idempotent message creation

Design Goals:

-   Stateless
-   Auto-scalable
-   Short-lived execution

------------------------------------------------------------------------

## 4. End-to-End Flow

1.  Admin logs in (Keycloak Admin Role)
2.  Admin creates promotion event (Draft)
3.  Admin publishes event
4.  Flink detects active event window
5.  Flink triggers Knative Rust job
6.  Rust job:
    -   Retrieves users
    -   Sends message via Message Service
7.  Message stored per user
8.  Customer logs in
9.  Inbox menu displays unread count
10. Customer reads message → status updated

------------------------------------------------------------------------

## 5. Frontend Enhancements (React)

### 5.1 Admin Portal

New Route:

/admin/event-calendar

Features:

-   Calendar view
-   Event interval visual marking
-   Draft / Publish control
-   Form validation
-   Professional scheduling UI

### 5.2 Customer UI

Inbox Menu:

-   Positioned left of Logout button
-   Displays unread count badge
-   Dropdown or dedicated page view
-   Pagination support

Standard UX:

-   Unread highlighted
-   Mark as read interaction
-   Real-time badge refresh (polling or websocket optional)

------------------------------------------------------------------------

## 6. Security Model

-   Keycloak role-based access
-   Admin endpoints secured via role check
-   Customer inbox restricted to authenticated user
-   Internal service-to-service authentication (JWT or mTLS)

------------------------------------------------------------------------

## 7. Data Isolation & Ownership

Each microservice owns its database:

-   Event Calendar DB
-   Message DB
-   Inventory DB
-   E-commerce DB

No cross-database sharing.

------------------------------------------------------------------------

## 8. Reliability & Idempotency

-   Knative job must prevent duplicate message creation
-   Unique constraint: (user_id, event_id, date)
-   Flink checkpointing enabled
-   Retry with exponential backoff

------------------------------------------------------------------------

## 9. Scalability Considerations

-   Horizontal scaling of Message Service
-   Knative auto-scaling
-   Flink distributed cluster mode
-   Stateless REST interactions

------------------------------------------------------------------------

## 10. Future Enhancements

-   WebSocket push notifications
-   Kafka instead of REST for async messaging
-   Promotion analytics dashboard
-   A/B testing for promotion messages
-   Event expiration auto-transition

------------------------------------------------------------------------

## 11. Benefits

-   Clear separation of responsibilities
-   Admin full control over promotion lifecycle
-   Automated time-based notification
-   Scalable distributed job execution
-   Improved customer engagement
-   Microservice-aligned domain boundaries

------------------------------------------------------------------------

## 12. Conclusion

This architecture enhancement introduces a robust, scalable, and
production-grade event-driven promotion system aligned with microservice
best practices. The combination of Flink scheduling, Knative execution,
and isolated microservices ensures flexibility, maintainability, and
future extensibility.
