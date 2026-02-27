# ── Stage 1: Build ───────────────────────────────────────────────────────────
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

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
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

USER app

EXPOSE 8080

# Attach OpenTelemetry Java agent via JAVA_TOOL_OPTIONS env var in k8s Deployment
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
