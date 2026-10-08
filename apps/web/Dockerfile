FROM node:24.21.0-bookworm-slim AS build
RUN npm install --global npm@12.1.0
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --workspace @real-time-chat/web --include-workspace-root
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
