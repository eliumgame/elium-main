# --- Passerelle IA Elium — image (multi-étapes) ------------------------------
# Même base épinglée par DIGEST que server/Dockerfile (un tag est mutable, un digest non).
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    GATEWAY_CONFIG=/app/config/gateway.json \
    USAGE_FILE=/app/data/usage.json \
    PORT=8790
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
# config/ est monté en lecture seule ; data/ (compteurs de consommation) est un volume.
RUN mkdir -p /app/config /app/data && chown -R node:node /app/data
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8790/health || exit 1
CMD ["node", "dist/server.js"]
