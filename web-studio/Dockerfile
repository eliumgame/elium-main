# --- Elium Web Studio — static SPA image (multi-stage) ---------------------
# Bases épinglées par DIGEST (tag conservé pour la lisibilité ; mises à jour par dependabot).
FROM node:20.17-alpine@sha256:2d07db07a2df6830718ae2a47db6fedce6745f5bcd174c398f2acdda90a11c03 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# VITE_API_BASE is baked at build time (the app talks to the same origin's /api
# by default; override for split deployments).
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

FROM caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d AS runtime
# Ne tourne PLUS en root : le serveur statique écoute sur 8080 (port > 1024, aucune capacité
# nécessaire) ; le caddy de bordure (docker-compose) fait le 80/443. Caddy écrit son état dans /tmp.
COPY --from=build /app/dist /usr/share/caddy
RUN printf '{\n\tauto_https off\n\tadmin off\n}\n:8080 {\n\troot * /usr/share/caddy\n\ttry_files {path} /index.html\n\tfile_server\n}\n' > /etc/caddy/Caddyfile
ENV XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config
USER 1000:1000
EXPOSE 8080
