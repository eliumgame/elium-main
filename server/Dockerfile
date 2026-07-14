# --- Elium Drive Entreprise — API image (multi-stage) ----------------------
# Pin deliberately; bump via a reviewed PR
FROM node:20.17-alpine AS build
WORKDIR /app
COPY package.json ./
# No committed lockfile yet: fall back to install. Add package-lock.json for
# reproducible builds (npm ci) once dependencies are locked.
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# migrate.ts reads ../db/schema.sql at runtime relative to dist/db/ — copy it in.
RUN cp src/db/schema.sql dist/db/schema.sql

# Pin deliberately; bump via a reviewed PR
FROM node:20.17-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
# The api writes encrypted blobs to /data/blobs (docker-compose `blobs`
# volume). Create it and hand ownership of it and /app to the non-root `node`
# user (uid 1000, built into node:alpine) before dropping root below — this
# also seeds the correct owner for the volume's first-use initialization.
RUN mkdir -p /data/blobs && chown -R node:node /app /data/blobs
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
