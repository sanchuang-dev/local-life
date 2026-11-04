# Run: docker build -f apps/api/Dockerfile -t local-life-api:<sha> .
# Build on CI, never on the shared 2C/2G prototype server.
FROM node:22-bookworm-slim AS builder
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /workspace
COPY . .
RUN corepack enable \
    && pnpm install --frozen-lockfile \
    && pnpm --filter @sanchuang-dev/local-life-contracts build \
    && pnpm --filter @sanchuang-dev/local-life-api build \
    && pnpm --filter @sanchuang-dev/local-life-api deploy --legacy --prod /runtime

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /runtime/ ./
USER node
EXPOSE 4080
CMD ["node", "dist/index.js"]
