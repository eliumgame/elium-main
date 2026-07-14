# --- Elium Drive Entreprise — API image (multi-stage) ----------------------
FROM node:20-alpine AS build
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

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["node", "dist/server.js"]
