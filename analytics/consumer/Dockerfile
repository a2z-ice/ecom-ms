# Build stage
FROM python:3.12-slim AS build
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --target=/app/deps -r requirements.txt

# Runtime stage
FROM python:3.12-slim
RUN addgroup --system app && adduser --system --ingroup app app
WORKDIR /app
COPY --from=build /app/deps /app/deps
COPY main.py .
ENV PYTHONPATH=/app/deps
ENV PYTHONUNBUFFERED=1
USER app
CMD ["python", "main.py"]
