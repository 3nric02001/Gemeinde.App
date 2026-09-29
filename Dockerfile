# syntax=docker/dockerfile:1

FROM node:26-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/index.html web/vite.config.ts web/tsconfig.json ./
COPY web/public ./public
COPY web/src ./src
RUN npm run build

FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
# better-sqlite3 bringt vorkompilierte Binaries für linux-x64/arm64 mit; ohne Skripte braucht es keinen Compiler.
RUN npm ci --ignore-scripts
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/library.db \
    WEB_DIR=/app/public
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
