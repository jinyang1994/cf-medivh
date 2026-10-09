FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY server/package*.json ./server/
COPY web/package*.json ./web/
RUN npm --prefix server ci && npm --prefix web ci
COPY server ./server
COPY web ./web
RUN npm --prefix server run build && npm --prefix web run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8788 DATABASE_PATH=/app/data/billing.sqlite
COPY --from=build /app/server/package*.json ./server/
RUN npm --prefix server ci --omit=dev
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 8788
CMD ["node", "server/dist/index.js"]
