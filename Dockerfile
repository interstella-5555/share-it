FROM oven/bun:1-alpine
WORKDIR /app
COPY src ./src
COPY openapi.json package.json ./

# Run as root: Railway volumes are mounted root:root and we can't chown
# a runtime-mounted path from the Dockerfile.

ENV PORT=3847 \
    DATA_DIR=/app/data \
    MAX_FILE_SIZE_MB=10 \
    PROTECTED_MODE=true
# ADMIN_KEY must be provided at run time (PROTECTED_MODE=true).
# BASE_URL should be set in prod to the public URL.

EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://localhost:3847/health || exit 1

CMD ["bun", "run", "src/server.ts"]
