FROM node:24.21.0-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global npm@12.1.0
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json ./apps/api/package.json

FROM base AS dependencies
RUN npm ci --workspace @real-time-chat/api --include-workspace-root

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
RUN npm test --workspace @real-time-chat/api && npm run build --workspace @real-time-chat/api

FROM dependencies AS development
RUN node node_modules/@prisma/engines/scripts/postinstall.js
COPY tsconfig.base.json ./
COPY --chown=node:node apps/api ./apps/api
RUN chown node:node /app/apps/api
COPY docker/database-env.mjs ./docker/database-env.mjs
ENV NODE_ENV=development HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
CMD ["sh", "-c", "npm run build --workspace @real-time-chat/api && exec node --import ./docker/database-env.mjs apps/api/dist/main.js"]

FROM dependencies AS migrate
# Download the migration engine at build time, before entering the internal network.
RUN node node_modules/@prisma/engines/scripts/postinstall.js
COPY apps/api/prisma ./apps/api/prisma
COPY apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY docker/database-env.mjs ./docker/database-env.mjs
USER node
ENTRYPOINT ["node", "--import", "./docker/database-env.mjs"]
CMD ["node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "apps/api/prisma.config.ts"]

FROM base AS runtime
RUN npm ci --omit=dev --omit=optional --workspace @real-time-chat/api --include-workspace-root
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY docker/database-env.mjs ./docker/database-env.mjs
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
ENTRYPOINT ["node", "--import", "./docker/database-env.mjs"]
CMD ["apps/api/dist/main.js"]
