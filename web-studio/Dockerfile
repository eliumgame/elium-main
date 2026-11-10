# --- Elium Web Studio — static SPA image (multi-stage) ---------------------
# Bases épinglées par DIGEST (tag conservé pour la lisibilité ; mises à jour par dependabot).
FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# VITE_API_BASE is baked at build time (the app talks to the same origin's /api
# by default; override for split deployments).
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

FROM caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5 AS runtime
# Ne tourne PLUS en root : le serveur statique écoute sur 8080 (port > 1024, aucune capacité
# nécessaire) ; le caddy de bordure (docker-compose) fait le 80/443. Caddy écrit son état dans /tmp.
COPY --from=build /app/dist /usr/share/caddy
# robots.txt est un vrai fichier statique (web-studio/public/robots.txt) servi avant le repli SPA.
# sitemap.xml n'existe pas (portail privé, rien à indexer) : 404 explicite plutôt que le HTML de la SPA.
# `route { }` est nécessaire : Caddy exécute les directives d'un bloc selon un ORDRE INTERNE fixe
# (file_server après respond, quel que soit l'ordre écrit ici), pas l'ordre textuel — sans route{},
# try_files/file_server traitaient /sitemap.xml avant que respond n'ait sa chance (200 HTML au lieu
# du 404 attendu, constaté en production).
RUN printf '{\n\tauto_https off\n\tadmin off\n}\n:8080 {\n\troute {\n\t\trespond /sitemap.xml 404\n\t\troot * /usr/share/caddy\n\t\ttry_files {path} /index.html\n\t\tfile_server\n\t}\n}\n' > /etc/caddy/Caddyfile
ENV XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config
USER 1000:1000
EXPOSE 8080
