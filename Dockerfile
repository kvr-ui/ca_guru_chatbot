# The CA Guru WhatsApp bot: one Express process (webhook + admin routes).

FROM node:22-alpine AS deps
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
RUN apk add --no-cache tzdata wget
ENV NODE_ENV=production
ENV TZ=Asia/Kolkata
# Inside a container 127.0.0.1 means "nobody can reach me"; compose publishes to localhost only.
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app
COPY --from=deps /build/node_modules ./node_modules
COPY package.json server.js ./
COPY src/     ./src/
COPY scripts/ ./scripts/
# Baked in: the answers a container gives are pinned to the commit it was built from.
COPY knowledge/ ./knowledge/

# Embeddings cache: derived data, kept in a volume so a redeploy does not re-pay OpenAI.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:$PORT/health || exit 1

CMD ["node", "server.js"]
