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

-- Revenue by Author: units sold and revenue per author
CREATE OR REPLACE VIEW vw_revenue_by_author AS
SELECT
    b.author,
    SUM(oi.quantity) AS units_sold,
    SUM(oi.quantity * oi.price_at_purchase) AS revenue
FROM fact_order_items oi
JOIN dim_books b ON b.id = oi.book_id
JOIN fact_orders o ON o.id = oi.order_id
WHERE o.status != 'CANCELLED'
GROUP BY b.author
ORDER BY revenue DESC;

-- Revenue by Genre: units sold and revenue per genre
CREATE OR REPLACE VIEW vw_revenue_by_genre AS
SELECT
    b.genre,
    SUM(oi.quantity) AS units_sold,
    SUM(oi.quantity * oi.price_at_purchase) AS revenue
FROM fact_order_items oi
JOIN dim_books b ON b.id = oi.book_id
JOIN fact_orders o ON o.id = oi.order_id
WHERE o.status != 'CANCELLED'
GROUP BY b.genre
ORDER BY revenue DESC;

-- Order Status Distribution: count and revenue by order status
CREATE OR REPLACE VIEW vw_order_status_distribution AS
SELECT
    o.status,
    COUNT(*) AS order_count,
    SUM(o.total) AS total_revenue
FROM fact_orders o
GROUP BY o.status
ORDER BY order_count DESC;

-- Inventory Health: stock levels with status labels
CREATE OR REPLACE VIEW vw_inventory_health AS
SELECT
    b.title,
    b.author,
    i.quantity AS stock_quantity,
    i.reserved,
    GREATEST(i.quantity - i.reserved, 0) AS available,
    CASE
        WHEN GREATEST(i.quantity - i.reserved, 0) = 0 THEN 'Critical'
        WHEN GREATEST(i.quantity - i.reserved, 0) <= 3 THEN 'Low'
        ELSE 'OK'
    END AS stock_status
FROM fact_inventory i
JOIN dim_books b ON b.id = i.book_id
ORDER BY available ASC;

-- Average Order Value: daily avg order value, daily revenue, order count
CREATE OR REPLACE VIEW vw_avg_order_value AS
SELECT
    DATE(o.created_at) AS sale_date,
    COUNT(*) AS order_count,
    ROUND(AVG(o.total)::NUMERIC, 2) AS avg_order_value,
    SUM(o.total) AS daily_revenue
FROM fact_orders o
WHERE o.status != 'CANCELLED'
GROUP BY DATE(o.created_at)
ORDER BY sale_date;

-- Top Books by Revenue: ranked by total revenue
CREATE OR REPLACE VIEW vw_top_books_by_revenue AS
SELECT
    b.title,
    b.author,
    SUM(oi.quantity) AS units_sold,
    SUM(oi.quantity * oi.price_at_purchase) AS total_revenue,
    RANK() OVER (ORDER BY SUM(oi.quantity * oi.price_at_purchase) DESC) AS revenue_rank
FROM fact_order_items oi
JOIN dim_books b ON b.id = oi.book_id
JOIN fact_orders o ON o.id = oi.order_id
WHERE o.status != 'CANCELLED'
GROUP BY b.id, b.title, b.author
ORDER BY revenue_rank;

-- Inventory Turnover: (units sold / current stock) × 100
CREATE OR REPLACE VIEW vw_inventory_turnover AS
SELECT
    b.title,
    b.author,
    i.quantity AS current_stock,
    COALESCE(SUM(oi.quantity), 0) AS total_sold,
    CASE
        WHEN i.quantity = 0 THEN 0
        ELSE ROUND((COALESCE(SUM(oi.quantity), 0)::NUMERIC / i.quantity) * 100, 1)
    END AS turnover_rate_pct
FROM fact_inventory i
JOIN dim_books b ON b.id = i.book_id
LEFT JOIN fact_order_items oi ON oi.book_id = b.id
LEFT JOIN fact_orders o ON o.id = oi.order_id AND o.status != 'CANCELLED'
GROUP BY b.id, b.title, b.author, i.quantity
ORDER BY turnover_rate_pct DESC;

-- Book Price Distribution: books bucketed by price range
CREATE OR REPLACE VIEW vw_book_price_distribution AS
SELECT
    CASE
        WHEN price < 10  THEN 'Under $10'
        WHEN price < 20  THEN '$10–$19'
        WHEN price < 30  THEN '$20–$29'
        WHEN price < 50  THEN '$30–$49'
        ELSE '$50+'
    END AS price_range,
    COUNT(*) AS book_count
FROM dim_books
GROUP BY price_range
ORDER BY MIN(price);
