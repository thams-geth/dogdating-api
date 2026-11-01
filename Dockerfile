
# syntax=docker/dockerfile:1

# Build application
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


# Download official Amazon RDS CA certificates
FROM node:22-bookworm-slim AS rds-ca

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL --retry 3 \
       https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
       -o /rds-global-bundle.pem \
    && test -s /rds-global-bundle.pem \
    && rm -rf /var/lib/apt/lists/*


# Production runtime
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY migrations ./migrations

# Add trusted Amazon RDS certificates
COPY --from=rds-ca /rds-global-bundle.pem /app/certs/rds-global-bundle.pem

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/server.js"]
