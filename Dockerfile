# ClanBot Sales Server — Stripe checkout + Pelican auto-provisioning.
# Slim, standalone image (no Puppeteer/Java). Runs as its own container,
# decoupled from the bot — it talks to Stripe and the Pelican panel only.
FROM node:22-bookworm-slim

# better-sqlite3 ships prebuilt binaries for linux x64/arm64. The build tools
# are a fallback so `npm ci` still succeeds if a prebuilt isn't available for
# the target architecture.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching. node_modules is excluded via
# .dockerignore so the host's (Windows) native build never leaks into the image.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV SALES_PORT=4000
EXPOSE 4000

CMD ["node", "server.js"]
