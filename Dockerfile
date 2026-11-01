
# syntax=docker/dockerfile:1

# Build application
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


# Download Amazon RDS CA certificates
FROM node:22-bookworm-slim AS rds-ca

RUN node --input-type=module -e '
import { writeFile } from "node:fs/promises";

const response = await fetch(
  "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem"
);

if (!response.ok) {
  throw new Error(`RDS certificate download failed: ${response.status}`);
}

await writeFile(
  "/rds-global-bundle.pem",
  Buffer.from(await response.arrayBuffer())
);
'


# Production runtime
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=rds-ca /rds-global-bundle.pem /app/certs/rds-global-bundle.pem
COPY migrations ./migrations

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/server.js"]
