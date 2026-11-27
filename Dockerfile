# ---- Derleme ----
# Taban imaj özetle sabit (2026-10-18): aynı etiket başka içerikle yeniden yayınlansa derleme değişmez.
# Güncellemek için: docker buildx imagetools inspect node:24-alpine
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build

# ---- Çalışma zamanı ----
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
# git: repoları klonlamak, docker-cli + compose: Compose uygulamaları, openssh-client: uzak sunucularda compose
RUN apk add --no-cache git docker-cli docker-cli-compose openssh-client tini unzip
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIST=/app/web \
    XUDBIN_PORT=3000
WORKDIR /app/server
COPY package.json package-lock.json /app/
COPY apps/server/package.json /app/apps/server/
COPY apps/web/package.json /app/apps/web/
# Yalnızca sunucunun çalışma bağımlılıkları; /app/server/dist içinden /app/node_modules'a çözümlenir.
RUN cd /app && npm ci --omit=dev -w @xudbin/server && npm cache clean --force
COPY --from=build /src/apps/server/dist ./dist
# dist/ ES modülü olarak yüklensin (aksi halde Node her açılışta uyarı verir).
COPY apps/server/package.json ./package.json
# Çalışma bağımlılıklarının hepsi dist/'in çalıştığı yerden yüklenebilmeli. Kilit dosyası bir paketi kök node_modules
# yerine apps/server/node_modules altına koyarsa (2026-11-27, hono güncellemesi) panel açılmıyordu; derleme burada durur.
RUN node --input-type=module -e "import fs from 'node:fs'; const d = Object.keys(JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies); for (const m of d) await import(m); console.log('Çalışma bağımlılıkları yüklendi:', d.length)"
COPY --from=build /src/apps/web/dist /app/web
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/auth/status >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
