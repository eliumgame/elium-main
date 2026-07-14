# --- Elium Web Studio — static SPA image (multi-stage) ---------------------
# Pin deliberately; bump via a reviewed PR
FROM node:20.17-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
# VITE_API_BASE is baked at build time (the app talks to the same origin's /api
# by default; override for split deployments).
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

# Pin deliberately; bump via a reviewed PR
FROM caddy:2.8-alpine AS runtime
# Stays root deliberately: Caddy needs cap_net_bind_service to bind :80, and
# this stage only ever serves this image's own static build with no secrets —
# an acceptable trade-off for a static file server.
# Serve the built SPA with history-API fallback.
COPY --from=build /app/dist /usr/share/caddy
RUN printf ':80 {\n\troot * /usr/share/caddy\n\ttry_files {path} /index.html\n\tfile_server\n}\n' > /etc/caddy/Caddyfile
EXPOSE 80
