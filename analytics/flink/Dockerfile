# Stage 1: Download connector JARs (alpine is multi-arch: amd64 + arm64)
FROM alpine:3.19 AS downloader

RUN apk add --no-cache curl

WORKDIR /jars

# Flink Kafka connector (matches Flink 1.20)
RUN curl -fsSL -o flink-connector-kafka-3.4.0-1.20.jar \
  "https://repo1.maven.org/maven2/org/apache/flink/flink-connector-kafka/3.4.0-1.20/flink-connector-kafka-3.4.0-1.20.jar"

# Flink JDBC connector (matches Flink 1.20)
RUN curl -fsSL -o flink-connector-jdbc-3.3.0-1.20.jar \
  "https://repo1.maven.org/maven2/org/apache/flink/flink-connector-jdbc/3.3.0-1.20/flink-connector-jdbc-3.3.0-1.20.jar"

# PostgreSQL JDBC driver
RUN curl -fsSL -o postgresql-42.7.4.jar \
  "https://repo1.maven.org/maven2/org/postgresql/postgresql/42.7.4/postgresql-42.7.4.jar"

# Kafka clients (required by Flink Kafka connector at runtime)
RUN curl -fsSL -o kafka-clients-3.7.0.jar \
  "https://repo1.maven.org/maven2/org/apache/kafka/kafka-clients/3.7.0/kafka-clients-3.7.0.jar"

# Stage 2: Flink runtime image with connectors baked in
FROM flink:1.20-scala_2.12-java17

# The base flink image already runs as non-root user 'flink' (UID 9999)
# Copy connector JARs to auto-classpath location
COPY --from=downloader /jars/*.jar /opt/flink/lib/
