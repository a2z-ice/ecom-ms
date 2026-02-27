# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json ./
RUN npm install --silent

COPY . .

# Build-time env vars injected here (or via k8s ConfigMap at runtime for nginx)
ARG VITE_KEYCLOAK_AUTHORITY
ARG VITE_KEYCLOAK_CLIENT_ID
ARG VITE_REDIRECT_URI

RUN npm run build

# ── Stage 2: Runtime (Nginx) ─────────────────────────────────────────────────
FROM nginx:1.27-alpine

# Run nginx as non-root
RUN addgroup --system --gid 1001 nginx-app && \
    adduser --system --uid 1001 --ingroup nginx-app --no-create-home nginx-app

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/conf.d/default.conf

# Allow nginx to write pid file and run as non-root
RUN chown -R nginx-app:nginx-app /var/cache/nginx /var/log/nginx /etc/nginx/conf.d && \
    touch /var/run/nginx.pid && \
    chown nginx-app:nginx-app /var/run/nginx.pid

USER nginx-app

EXPOSE 80
