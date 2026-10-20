# The sandboxed worker: runs one Quest through the model gateway and the MCP gateway, holding
# only its per-run token and lease handle. Build context is the repo root.
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS build
WORKDIR /repo
COPY package.json bun.lock ./
COPY apps/guildd/package.json apps/guildd/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile --filter @guildhall/guildd
COPY apps/guildd/src/worker.ts apps/guildd/src/worker-main.ts apps/guildd/src/
RUN bun build apps/guildd/src/worker-main.ts --target=bun --outfile=/out/worker.js

FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288
COPY --from=build /out/worker.js /app/worker.js
USER 65532:65532
WORKDIR /tmp
CMD ["bun", "/app/worker.js"]
