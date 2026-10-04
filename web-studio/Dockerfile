# --- Elium Web Studio — static SPA image (multi-stage) ---------------------
# Bases épinglées par DIGEST (tag conservé pour la lisibilité ; mises à jour par dependabot).
FROM node:20.20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# VITE_API_BASE is baked at build time (the app talks to the same origin's /api
# by default; override for split deployments).
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

FROM caddy:2.8-alpine@sha256:af32e97399febea808609119bb21544d0265c58a02836576e32a2d082c262c17 AS runtime
# Ne tourne PLUS en root : le serveur statique écoute sur 8080 (port > 1024, aucune capacité
# nécessaire) ; le caddy de bordure (docker-compose) fait le 80/443. Caddy écrit son état dans /tmp.
COPY --from=build /app/dist /usr/share/caddy
RUN printf '{\n\tauto_https off\n\tadmin off\n}\n:8080 {\n\troot * /usr/share/caddy\n\ttry_files {path} /index.html\n\tfile_server\n}\n' > /etc/caddy/Caddyfile
ENV XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config
USER 1000:1000
EXPOSE 8080
