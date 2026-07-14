# --- Elium Web Studio — static SPA image (multi-stage) ---------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
# VITE_API_BASE is baked at build time (the app talks to the same origin's /api
# by default; override for split deployments).
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

FROM caddy:2-alpine AS runtime
# Serve the built SPA with history-API fallback.
COPY --from=build /app/dist /usr/share/caddy
RUN printf ':80 {\n\troot * /usr/share/caddy\n\ttry_files {path} /index.html\n\tfile_server\n}\n' > /etc/caddy/Caddyfile
EXPOSE 80
