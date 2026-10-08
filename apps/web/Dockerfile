FROM node:24.21.0-bookworm-slim AS dependencies
RUN npm install --global npm@12.1.0
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --workspace @real-time-chat/web --include-workspace-root

FROM dependencies AS development
COPY tsconfig.base.json ./
COPY --chown=node:node apps/web ./apps/web
RUN chown node:node /app/apps/web
USER node
EXPOSE 8080
CMD ["npm", "start", "--workspace", "@real-time-chat/web", "--", "--host", "0.0.0.0", "--port", "8080", "--proxy-config", "proxy.docker.json"]

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY apps/web ./apps/web
RUN npm test --workspace @real-time-chat/web && npm run build --workspace @real-time-chat/web

FROM nginx:1.30.5-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/apps/web/dist/browser /usr/share/nginx/html
USER nginx
EXPOSE 8080
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
