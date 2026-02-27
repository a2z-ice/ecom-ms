-- Analytics DB schema
-- Populated via Debezium CDC (Kafka → JDBC Sink Connector)
-- Column names intentionally match the source tables so the JDBC sink
-- can write without any field-rename transforms.
-- No FK constraints: CDC delivery order is not guaranteed.

CREATE TABLE IF NOT EXISTS dim_books (
    id             UUID PRIMARY KEY,
    title          VARCHAR(255),
    author         VARCHAR(255),
    price          DOUBLE PRECISION,
    description    TEXT,
    cover_url      TEXT,
    isbn           VARCHAR(20),
    genre          VARCHAR(100),
    published_year INT,
    created_at     TIMESTAMP WITH TIME ZONE,
    synced_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fact_orders (
    id          UUID PRIMARY KEY,
    user_id     VARCHAR(255),
    total       DOUBLE PRECISION,
    status      VARCHAR(50),
    created_at  TIMESTAMP WITH TIME ZONE,
    synced_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fact_order_items (
    id                UUID PRIMARY KEY,
    order_id          UUID,
    book_id           UUID,
    quantity          INT,
    price_at_purchase DOUBLE PRECISION,
    synced_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fact_inventory (
    book_id     UUID PRIMARY KEY,
    quantity    INT,
    reserved    INT,
    updated_at  TIMESTAMP WITH TIME ZONE,
    synced_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Views used by Superset dashboards

-- Product Sales Volume: units sold per book
CREATE OR REPLACE VIEW vw_product_sales_volume AS
SELECT
    b.title,
    b.author,
    SUM(oi.quantity) AS units_sold,
    SUM(oi.quantity * oi.price_at_purchase) AS revenue
FROM fact_order_items oi
JOIN dim_books b ON b.id = oi.book_id
JOIN fact_orders o ON o.id = oi.order_id
WHERE o.status != 'CANCELLED'
GROUP BY b.id, b.title, b.author
ORDER BY units_sold DESC;

-- Sales Over Time: daily revenue trend
CREATE OR REPLACE VIEW vw_sales_over_time AS
SELECT
    DATE(o.created_at) AS sale_date,
    COUNT(DISTINCT o.id) AS order_count,
    SUM(o.total) AS daily_revenue
FROM fact_orders o
WHERE o.status != 'CANCELLED'
GROUP BY DATE(o.created_at)
ORDER BY sale_date;
