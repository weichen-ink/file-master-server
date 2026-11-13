FROM node:20-slim

# Install git, cpulimit, libheif-examples, ffmpeg, fontconfig, and CJK fonts for text watermarking
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    cpulimit \
    ca-certificates \
    libheif-examples \
    ffmpeg \
    fontconfig \
    fonts-noto-cjk \
    fonts-wqy-zenhei \
    fonts-wqy-microhei \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY config.example.yaml ./config.example.yaml

# Ensure persistent runtime directories exist
RUN mkdir -p /app/storage/raw /app/storage/cache /app/storage/trash /app/storage/tmp /app/data

ENV NODE_ENV=production
ENV PORT=3210

EXPOSE 3210

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3210) + '/api/platform/version').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]

