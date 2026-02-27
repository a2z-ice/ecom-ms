# ── Stage 1: Build / dependency install ───────────────────────────────────────
FROM python:3.12-slim AS build
WORKDIR /app

RUN pip install --no-cache-dir poetry==1.8.3

COPY pyproject.toml poetry.lock* ./
RUN poetry config virtualenvs.create false && \
    poetry install --only main --no-interaction --no-ansi

COPY . .

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM python:3.12-slim

RUN addgroup --system --gid 1001 app && \
    adduser --system --uid 1001 --gid 1001 --no-create-home app

WORKDIR /app

COPY --from=build /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=build /usr/local/bin/uvicorn /usr/local/bin/uvicorn
COPY --from=build /app .

USER app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
