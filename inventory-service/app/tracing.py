import os

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource


def setup_tracing():
    """Configure OpenTelemetry distributed tracing.

    Sends trace spans to the OTel Collector via gRPC.
    Skips setup when OTEL_EXPORTER_OTLP_ENDPOINT is not set (local dev).
    """
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
    if not endpoint:
        return  # Skip if no endpoint configured (local dev)

    resource = Resource.create(
        {"service.name": os.getenv("OTEL_SERVICE_NAME", "inventory-service")}
    )
    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=endpoint, insecure=True)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
