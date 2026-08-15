# syntax=docker/dockerfile:1
#
# Container image for @houtini/seo-audit-console (stdio MCP server).
# dist/ is gitignored -> build from source. Uses better-sqlite3, a NATIVE module,
# so the build stage carries a C++ toolchain; the runtime stage gets only the
# already-compiled node_modules + built dist (no toolchain shipped).
#
# Runtime config (set by the MCP client, not baked in): GOOGLE_APPLICATION_CREDENTIALS
# (GSC service-account json), SAC_DATA_DIR (SQLite data dir), DataForSEO / Majestic /
# Firecrawl / Supadata keys.

# --- build stage: toolchain + full build ------------------------------------
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# --ignore-scripts skips the root prepare/prepublish (would run tsc before src is copied).
RUN npm ci --ignore-scripts || npm install --ignore-scripts
COPY . .
# --ignore-scripts also skipped better-sqlite3's compile; do it explicitly now.
RUN npm rebuild better-sqlite3
RUN npm run build
# drop devDeps; better-sqlite3 is a prod dep so its compiled binary is kept.
RUN npm prune --omit=dev

# --- runtime: compiled node_modules + built dist only -----------------------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
ENTRYPOINT ["node", "dist/index.js"]
