# Working in this repository

Read PROJECT_MEMORY.md and docs/IMPLEMENTATION.md before making changes. Use docs/API_PLAN.md for product/API scope and docs/RESEARCH.md for source context. Latest user instructions take precedence.

Use TypeScript, Express and PostgreSQL. Keep features under src/modules with routes, schemas, service and repository as needed. Reuse shared infrastructure, validate writes, check resource permissions, avoid exposing private data.

Do not edit applied migrations. Add a forward migration. Do not touch unrelated Docker containers or databases.

The user requested a focused commit per completed module. Update README, the implementation ledger and project memory when behavior/status changes. Keep unimplemented and development-only functionality explicit. Run typecheck, build and tests relevant to each module before committing. Never commit .env, credentials, raw tokens or private user data. Do not push or deploy unless requested.

Every module must include a mobile/web handover in docs/handovers with implemented/planned status, API methods, access rules, HTTP/error codes, request/response contracts and examples, client retry/state handling, a Mermaid flow and a screen wireframe. Backfill and maintain existing modules as contracts change. Update scripts/handover-notes.mjs and OpenAPI, run npm run docs:handovers, then npm run check:handovers. Add endpoint-to-module mapping in scripts/generate-handovers.mjs when implementing a new module. Do not invent contracts for planned APIs.
