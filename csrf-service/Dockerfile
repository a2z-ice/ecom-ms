# Build stage
FROM golang:1.25-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o csrf-service .

# Runtime stage
FROM gcr.io/distroless/static:nonroot
WORKDIR /app
COPY --from=build /app/csrf-service .
USER nonroot:nonroot
EXPOSE 8080
CMD ["./csrf-service"]
