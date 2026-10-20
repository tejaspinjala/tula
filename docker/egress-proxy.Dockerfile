# The egress proxy: the only way out of a sandbox. Build context is the repo root.
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS build
WORKDIR /repo
COPY package.json bun.lock ./
COPY apps/guildd/package.json apps/guildd/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile --filter @guildhall/guildd
COPY apps/guildd/src/egress-proxy.ts apps/guildd/src/egress-proxy-main.ts apps/guildd/src/
RUN bun build apps/guildd/src/egress-proxy-main.ts --target=bun --outfile=/out/egress-proxy.js

FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288
COPY --from=build /out/egress-proxy.js /app/egress-proxy.js
USER 65532:65532
EXPOSE 3128
CMD ["bun", "/app/egress-proxy.js"]
