# ---- Derleme ----
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build

# ---- Çalışma zamanı ----
FROM node:24-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIST=/app/web \
    XUDBIN_PORT=3000
WORKDIR /app/server
COPY package.json package-lock.json /app/
COPY apps/server/package.json /app/apps/server/
COPY apps/web/package.json /app/apps/web/
# Sadece sunucunun çalışma bağımlılıkları; /app/server/dist içinden /app/node_modules'a çözümlenir.
RUN cd /app && npm ci --omit=dev -w @xudbin/server && npm cache clean --force
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/web/dist /app/web
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/auth/status >/dev/null || exit 1
CMD ["node", "dist/index.js"]
