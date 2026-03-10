# Build stage — builds both operator manager and dashboard binaries
FROM golang:1.24 AS builder
ARG TARGETOS
ARG TARGETARCH

WORKDIR /workspace
COPY go.mod go.mod
COPY go.sum go.sum
RUN go mod download

COPY cmd/ cmd/
COPY api/ api/
COPY internal/ internal/
COPY hack/ hack/

# Build operator manager
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    go build -a -o manager cmd/main.go

# Build dashboard server
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    go build -a -o dashboard cmd/dashboard/main.go

# Runtime stage
FROM gcr.io/distroless/static:nonroot
WORKDIR /
COPY --from=builder /workspace/manager .
COPY --from=builder /workspace/dashboard .
USER 65532:65532

ENTRYPOINT ["/manager"]
