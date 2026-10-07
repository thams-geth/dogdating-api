# Waggle API

TypeScript + Express + PostgreSQL backend for Waggle. This project uses the existing Waggle SQL schema and is being built in small, runnable slices.

## Run locally

Requires Node 22+ and Docker.

```sh
npm install
docker compose up -d postgres
npm run migrate
npm run dev
```

- `GET /v1/health` checks the HTTP process.
- `GET /v1/ready` checks PostgreSQL connectivity.
- `GET /v1/dogs/breeds` reads the breed catalogue from PostgreSQL.
- `npm run typecheck` and `npm run build` verify TypeScript.

The copied SQL migrations are from `Dog dating/waggle/backend/migrations`. Change them only by adding a new migration; the runner rejects changes to migrations already applied.

## Current scope

This is the first Express slice: project setup, database migrations, HTTP error format, and health checks. Authentication and the remaining product endpoints are next; the copied schema alone does not make those routes available.
