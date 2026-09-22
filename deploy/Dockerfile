# Node 22 is required by node:sqlite and the shared TypeScript scene model.
FROM node:22-bookworm-slim
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY package.json package-lock.json ./
COPY tools/eval/package.json tools/eval/package-lock.json ./tools/eval/
RUN npm ci --no-audit --no-fund
# https://playwright.dev/docs/docker — install the browser matching our lockfile.
RUN npx playwright install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-rus \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm run build && npm run build:mcp
ENV NODE_ENV=production
USER node
CMD ["node", "services/api/server.mjs"]
