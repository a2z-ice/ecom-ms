# ── Stage 1: Build ───────────────────────────────────────────────────────────
# Pin to digest: run `bash scripts/pin-image-digests.sh` when Docker is available
FROM eclipse-temurin:21-jdk-alpine AS build
WORKDIR /workspace

COPY pom.xml .
COPY src ./src

# Download dependencies first (layer cached separately from source)
RUN --mount=type=cache,target=/root/.m2 \
    apk add --no-cache maven && \
    mvn dependency:go-offline -q

RUN --mount=type=cache,target=/root/.m2 \
    mvn package -DskipTests -q

# Extract layered JAR for optimal Docker layer caching
RUN java -Djarmode=layertools -jar target/*.jar extract --destination /workspace/extracted

RUN mkdir -p /otel && \
    apk add --no-cache curl && \
    curl -L -o /otel/opentelemetry-javaagent.jar \
      https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v2.25.0/opentelemetry-javaagent.jar && \
    test -s /otel/opentelemetry-javaagent.jar && \
    ls -la /otel/opentelemetry-javaagent.jar

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
# Pin to digest: run `bash scripts/pin-image-digests.sh` when Docker is available
FROM eclipse-temurin:21-jre-alpine

# Create non-root user
RUN addgroup --system --gid 1001 app && \
    adduser --system --uid 1001 --ingroup app --no-create-home app

WORKDIR /app

# Copy layered JAR contents (best cache re-use order: dependencies → spring-boot → app)
COPY --from=build /workspace/extracted/dependencies/ ./
COPY --from=build /workspace/extracted/spring-boot-loader/ ./
COPY --from=build /workspace/extracted/snapshot-dependencies/ ./
COPY --from=build /workspace/extracted/application/ ./

COPY --from=build /otel/opentelemetry-javaagent.jar /otel/opentelemetry-javaagent.jar

USER app

EXPOSE 8080

# Attach OpenTelemetry Java agent via JAVA_TOOL_OPTIONS env var in k8s Deployment
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
