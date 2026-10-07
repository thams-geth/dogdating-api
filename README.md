# Waggle API

India-first dog social/matching backend built with TypeScript, Express and PostgreSQL, with country expansion planned from the beginning.

## Plan and project memory

- [API plan](docs/API_PLAN.md): full journey, endpoint catalogue, data rules, implementation order and launch gates.
- [Research](docs/RESEARCH.md): dated primary sources and their practical implications.
- [Implementation ledger](docs/IMPLEMENTATION.md): what works today and what remains.
- [Project memory](PROJECT_MEMORY.md): user decisions, environment and handoff for future sessions.

The current launch assumption is dog playdates/walks. Breeding introductions and owner dating are separate planned surfaces; launch mode is awaiting the founder's clarification.

## Local development

Requires Node 22+ and Docker. The PostgreSQL port is 5433 so it can coexist with other projects.

```sh
npm ci
cp .env.example .env
docker compose up -d postgres
npm run migrate
npm run dev
```

`npm run typecheck` and `npm run build` check the backend. Current endpoints are `GET /v1/health`, `GET /v1/ready` and `GET /v1/dogs/breeds`. All other endpoints in the plan are planned until marked implemented in the ledger.

Migrations 0001–0011 came from the earlier Waggle backend. The migration runner rejects changed applied SQL. Add new migrations when implementing a module.

## App configuration

`GET /v1/app/countries` lists configured markets. `GET /v1/app/bootstrap?platform=android&buildNumber=1&countryCode=IN&locale=en-IN` returns country availability, update guidance and feature flags. India currently has `development` rollout; unbuilt product features are disabled. Reviewed legal documents and published store links are not configured yet.

Run `npm test` for HTTP/configuration tests. [OpenAPI](docs/openapi.yaml) describes implemented routes. App release policy lives in `src/modules/app/policy.ts`; numeric build numbers avoid incorrect string comparisons such as treating build 9 as newer than build 12.
