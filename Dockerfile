# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @spark/api run db:generate
RUN pnpm exec turbo run build --filter=@spark/api

# --prod removes already-installed devDependencies (jest, ts-node, typescript, the
# Nest/Prisma CLIs, pino-pretty) in place, so the workspace symlink layout that pnpm
# built above — the thing that breaks if you reconstruct it across a stage copy — never
# has to be rebuilt. @prisma/client (a prod dep) and its generated engine, written
# earlier into the pnpm store by db:generate, are untouched by this prune.
RUN pnpm install --frozen-lockfile --prod

FROM node:20-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S spark -u 1001 -G nodejs

COPY --from=build --chown=spark:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=spark:nodejs /app/packages ./packages
COPY --from=build --chown=spark:nodejs /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=spark:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=spark:nodejs /app/apps/api/prisma ./apps/api/prisma
COPY --from=build --chown=spark:nodejs /app/apps/api/package.json ./apps/api/package.json

WORKDIR /app/apps/api
USER spark
ENV NODE_ENV=production

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/v1/health || exit 1

CMD ["node", "dist/main.js"]
