# --- Elium Drive Entreprise — API image (multi-stage) ----------------------
# Base épinglée par DIGEST (le tag n'est là que pour la lisibilité) : un tag est mutable, un digest
# non. Mise à jour : dependabot (docker) ou `docker buildx imagetools inspect node:<tag>`.
FROM node:20.17-alpine@sha256:2d07db07a2df6830718ae2a47db6fedce6745f5bcd174c398f2acdda90a11c03 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` : installe EXACTEMENT le verrou et échoue s'il diverge de package.json.
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# migrate.ts reads ./migrations/*.sql at runtime relative to dist/db/ — tsc does
# not emit .sql, so copy the migration files into the compiled output.
RUN cp -r src/db/migrations dist/db/migrations

FROM node:20.17-alpine@sha256:2d07db07a2df6830718ae2a47db6fedce6745f5bcd174c398f2acdda90a11c03 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
# The api writes encrypted blobs to /data/blobs (docker-compose `blobs`
# volume). Create it and hand ownership of it and /app to the non-root `node`
# user (uid 1000, built into node:alpine) before dropping root below — this
# also seeds the correct owner for the volume's first-use initialization.
RUN mkdir -p /data/blobs && chown -R node:node /app /data/blobs
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
