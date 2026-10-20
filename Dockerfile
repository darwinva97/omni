# Una imagen para la API y el panel (cambia el comando de arranque).
#   API:   node apps/api/dist/main.js
#   Panel: cd apps/web && node_modules/.bin/next start -p 4011
#
# Compila paquete a paquete con tsc y empaqueta los plugins. No sale imagen si
# fallan las pruebas unitarias: una imagen con código nuevo y sin probar es justo
# lo que no debe llegar a producción.

FROM node:22-bookworm-slim AS build
ENV CI=true
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile

RUN set -e; \
    for p in packages/shared packages/platform packages/db packages/storage \
             packages/core packages/channels packages/plugins packages/media \
             apps/engine apps/api apps/cli; do \
      (cd "$p" && ../../node_modules/.bin/tsc -p tsconfig.json); \
    done; \
    node packages/plugins/scripts/bundle.mjs
RUN pnpm test
RUN cd apps/web && NEXT_TELEMETRY_DISABLED=1 node_modules/.bin/next build

FROM node:22-bookworm-slim
# ffmpeg: notas de voz y vídeos del navegador al formato que WhatsApp reproduce.
# tini: reenvía las señales, para que un reinicio cierre las sesiones con orden.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    FFMPEG_PATH=/usr/bin/ffmpeg
EXPOSE 4010 4011
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
