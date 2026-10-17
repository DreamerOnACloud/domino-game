# Cloud Run image for the domino game server.
# The app reads PORT (Cloud Run injects 8080) and binds all interfaces.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so the layer caches across code-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

ENV PORT=8080
EXPOSE 8080

# Run unprivileged; the node user ships with the official image.
USER node

CMD ["node", "server.js"]
