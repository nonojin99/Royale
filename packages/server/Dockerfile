# 게임 서버 이미지 (Fly.io 배포용)
# 루트에서 빌드한다:  docker build -f packages/server/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable

# 의존성 먼저 (레이어 캐시)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile --filter @royale/shared... --filter @royale/server...

# 소스 빌드 (클라이언트는 이미지에 넣지 않는다 — 정적 호스팅으로 따로 나간다)
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN pnpm --filter @royale/shared build && pnpm --filter @royale/server build

# 프로덕션 의존성만 남긴다
RUN pnpm --filter @royale/server --prod deploy /out


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./package.json

EXPOSE 8787
USER node
CMD ["node", "dist/index.js"]
