-- Flink SQL CDC Pipeline
-- Reads Debezium CDC events from Kafka using plain JSON format
-- Debezium sends plain JSON envelope (schemas.enable=false):
--   {"before": null, "after": {<columns>}, "op": "c|u|d|r", "source": {...}, ...}
-- Extracts `after` field from Debezium envelope
-- Writes to analytics PostgreSQL DB via JDBC upsert

-- ─────────────────────────────────────────────────────────────────────────────
-- SOURCE TABLES (Kafka + json format — parses Debezium plain JSON envelope)
-- Debezium message structure (schemas.enable=false):
--   {"before": null, "after": {<columns>}, "op": "c|u|d|r", "source": {...}}
-- op: c=create, u=update, d=delete, r=read (snapshot)
-- TIMESTAMP WITH TIME ZONE → ISO 8601 string: "2026-02-26T18:58:09.811060Z"
--   → stored as STRING, converted in INSERT: REPLACE 'T'/' ', strip 'Z', CAST
-- decimal.handling.mode=double → DOUBLE (no casting needed)
-- json.ignore-parse-errors: skip tombstone/control messages silently
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE kafka_orders (
  `after` ROW<
    id         STRING,
    user_id    STRING,
    total      DOUBLE,
    status     STRING,
    created_at STRING
  >,
  `op` STRING
) WITH (
  'connector'                              = 'kafka',
  'topic'                                  = 'ecom-connector.public.orders',
  'properties.bootstrap.servers'           = 'kafka.infra.svc.cluster.local:9092',
  'properties.group.id'                    = 'flink-analytics-consumer',
  'format'                                 = 'json',
  'json.ignore-parse-errors'               = 'true',
  'scan.startup.mode'                                 = 'earliest-offset',

  -- Partition discovery: ENABLED (required for Kafka scaling; correct production behavior)
  -- New TABLES still require a SQL change + job resubmit; partition discovery only
  -- auto-detects new partitions on existing topics (e.g. Kafka throughput scaling).
  'scan.topic-partition-discovery.interval'           = '300000',

  -- AdminClient connection resilience: fixes NAT idle connection issue in kind.
  -- Root cause: AdminClient connection sits idle for 5 min between discovery calls;
  -- NAT entry expires silently; reconnect hits a race condition in KRaft metadata.
  -- Fix: set idle timeout (180s) < discovery interval (300s) so AdminClient proactively
  -- closes the connection before NAT can expire it. Each discovery cycle opens a fresh
  -- connection → no stale NAT state → no UnknownTopicOrPartitionException.
  'properties.connections.max.idle.ms'                = '180000',
  'properties.reconnect.backoff.ms'                   = '1000',
  'properties.reconnect.backoff.max.ms'               = '10000',
  'properties.request.timeout.ms'                     = '30000',
  'properties.socket.connection.setup.timeout.ms'     = '10000',
  'properties.socket.connection.setup.timeout.max.ms' = '30000',
  'properties.metadata.max.age.ms'                    = '300000'
);

CREATE TABLE kafka_order_items (
  `after` ROW<
    id                STRING,
    order_id          STRING,
    book_id           STRING,
    quantity          INT,
    price_at_purchase DOUBLE
  >,
  `op` STRING
) WITH (
  'connector'                              = 'kafka',
  'topic'                                  = 'ecom-connector.public.order_items',
  'properties.bootstrap.servers'           = 'kafka.infra.svc.cluster.local:9092',
  'properties.group.id'                    = 'flink-analytics-consumer',
  'format'                                 = 'json',
  'json.ignore-parse-errors'               = 'true',
  'scan.startup.mode'                                 = 'earliest-offset',

  'scan.topic-partition-discovery.interval'           = '300000',

  'properties.connections.max.idle.ms'                = '180000',
  'properties.reconnect.backoff.ms'                   = '1000',
  'properties.reconnect.backoff.max.ms'               = '10000',
  'properties.request.timeout.ms'                     = '30000',
  'properties.socket.connection.setup.timeout.ms'     = '10000',
  'properties.socket.connection.setup.timeout.max.ms' = '30000',
  'properties.metadata.max.age.ms'                    = '300000'
);

CREATE TABLE kafka_books (
  `after` ROW<
    id             STRING,
    title          STRING,
    author         STRING,
    price          DOUBLE,
    description    STRING,
    cover_url      STRING,
    isbn           STRING,
    genre          STRING,
    published_year INT,
    created_at     STRING
  >,
  `op` STRING
) WITH (
  'connector'                              = 'kafka',
  'topic'                                  = 'ecom-connector.public.books',
  'properties.bootstrap.servers'           = 'kafka.infra.svc.cluster.local:9092',
  'properties.group.id'                    = 'flink-analytics-consumer',
  'format'                                 = 'json',
  'json.ignore-parse-errors'               = 'true',
  'scan.startup.mode'                                 = 'earliest-offset',

  'scan.topic-partition-discovery.interval'           = '300000',

  'properties.connections.max.idle.ms'                = '180000',
  'properties.reconnect.backoff.ms'                   = '1000',
  'properties.reconnect.backoff.max.ms'               = '10000',
  'properties.request.timeout.ms'                     = '30000',
  'properties.socket.connection.setup.timeout.ms'     = '10000',
  'properties.socket.connection.setup.timeout.max.ms' = '30000',
  'properties.metadata.max.age.ms'                    = '300000'
);

CREATE TABLE kafka_inventory (
  `after` ROW<
    book_id    STRING,
    quantity   INT,
    reserved   INT,
    updated_at STRING
  >,
  `op` STRING
) WITH (
  'connector'                              = 'kafka',
  'topic'                                  = 'inventory-connector.public.inventory',
  'properties.bootstrap.servers'           = 'kafka.infra.svc.cluster.local:9092',
  'properties.group.id'                    = 'flink-analytics-consumer',
  'format'                                 = 'json',
  'json.ignore-parse-errors'               = 'true',
  'scan.startup.mode'                                 = 'earliest-offset',

  'scan.topic-partition-discovery.interval'           = '300000',

  'properties.connections.max.idle.ms'                = '180000',
  'properties.reconnect.backoff.ms'                   = '1000',
  'properties.reconnect.backoff.max.ms'               = '10000',
  'properties.request.timeout.ms'                     = '30000',
  'properties.socket.connection.setup.timeout.ms'     = '10000',
  'properties.socket.connection.setup.timeout.max.ms' = '30000',
  'properties.metadata.max.age.ms'                    = '300000'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- SINK TABLES (JDBC → PostgreSQL analytics-db)
-- PRIMARY KEY enables JDBC upsert mode (INSERT ... ON CONFLICT DO UPDATE)
-- ?stringtype=unspecified: allows PostgreSQL to cast varchar → uuid implicitly
-- sink.buffer-flush: batch 100 rows / 5s interval for throughput
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE sink_fact_orders (
  id         STRING,
  user_id    STRING,
  total      DOUBLE,
  status     STRING,
  created_at TIMESTAMP(3),
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector'                   = 'jdbc',
  'url'                         = 'jdbc:postgresql://analytics-db.analytics.svc.cluster.local:5432/analyticsdb?stringtype=unspecified',
  'table-name'                  = 'fact_orders',
  'username'                    = '${ANALYTICS_DB_USER}',
  'password'                    = '${ANALYTICS_DB_PASSWORD}',
  'sink.buffer-flush.max-rows'  = '100',
  'sink.buffer-flush.interval'  = '5s'
);

CREATE TABLE sink_fact_order_items (
  id                STRING,
  order_id          STRING,
  book_id           STRING,
  quantity          INT,
  price_at_purchase DOUBLE,
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector'                   = 'jdbc',
  'url'                         = 'jdbc:postgresql://analytics-db.analytics.svc.cluster.local:5432/analyticsdb?stringtype=unspecified',
  'table-name'                  = 'fact_order_items',
  'username'                    = '${ANALYTICS_DB_USER}',
  'password'                    = '${ANALYTICS_DB_PASSWORD}',
  'sink.buffer-flush.max-rows'  = '100',
  'sink.buffer-flush.interval'  = '5s'
);

CREATE TABLE sink_dim_books (
  id             STRING,
  title          STRING,
  author         STRING,
  price          DOUBLE,
  description    STRING,
  cover_url      STRING,
  isbn           STRING,
  genre          STRING,
  published_year INT,
  created_at     TIMESTAMP(3),
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector'                   = 'jdbc',
  'url'                         = 'jdbc:postgresql://analytics-db.analytics.svc.cluster.local:5432/analyticsdb?stringtype=unspecified',
  'table-name'                  = 'dim_books',
  'username'                    = '${ANALYTICS_DB_USER}',
  'password'                    = '${ANALYTICS_DB_PASSWORD}',
  'sink.buffer-flush.max-rows'  = '100',
  'sink.buffer-flush.interval'  = '5s'
);

CREATE TABLE sink_fact_inventory (
  book_id    STRING,
  quantity   INT,
  reserved   INT,
  updated_at TIMESTAMP(3),
  PRIMARY KEY (book_id) NOT ENFORCED
) WITH (
  'connector'                   = 'jdbc',
  'url'                         = 'jdbc:postgresql://analytics-db.analytics.svc.cluster.local:5432/analyticsdb?stringtype=unspecified',
  'table-name'                  = 'fact_inventory',
  'username'                    = '${ANALYTICS_DB_USER}',
  'password'                    = '${ANALYTICS_DB_PASSWORD}',
  'sink.buffer-flush.max-rows'  = '100',
  'sink.buffer-flush.interval'  = '5s'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- PIPELINE STATEMENTS
-- Filter: WHERE `after` IS NOT NULL skips DELETE events (op='d') and tombstones
-- Timestamps: ISO 8601 "2026-02-26T18:58:09.811060Z"
--   → REPLACE 'T' with ' ', strip 'Z' → "2026-02-26 18:58:09.811060"
--   → CAST AS TIMESTAMP(3) (Flink accepts up to 6 fractional digits)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO sink_fact_orders
SELECT `after`.id, `after`.user_id, `after`.total, `after`.status,
       CAST(REPLACE(REPLACE(`after`.created_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3))
FROM kafka_orders
WHERE `after` IS NOT NULL;

INSERT INTO sink_fact_order_items
SELECT `after`.id, `after`.order_id, `after`.book_id, `after`.quantity, `after`.price_at_purchase
FROM kafka_order_items
WHERE `after` IS NOT NULL;

INSERT INTO sink_dim_books
SELECT `after`.id, `after`.title, `after`.author, `after`.price, `after`.description,
       `after`.cover_url, `after`.isbn, `after`.genre, `after`.published_year,
       CAST(REPLACE(REPLACE(`after`.created_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3))
FROM kafka_books
WHERE `after` IS NOT NULL;

INSERT INTO sink_fact_inventory
SELECT `after`.book_id, `after`.quantity, `after`.reserved,
       CAST(REPLACE(REPLACE(`after`.updated_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3))
FROM kafka_inventory
WHERE `after` IS NOT NULL;
