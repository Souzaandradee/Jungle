FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
RUN bun run build

FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src/infra/database/mikro-orm.config.ts ./src/infra/database/mikro-orm.config.ts
COPY --from=build /app/src/infra/database/wallet.record.ts ./src/infra/database/wallet.record.ts
CMD ["sh", "-c", "bun run migrate && bun run start:prod"]
