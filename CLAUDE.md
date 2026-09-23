# sPark API — Claude Code governance

NestJS + Fastify. Port 3001 by default (`.env` may override — local dev currently uses 3010).

This repo is **self-contained**: it has its own lockfile, its own `node_modules`, its own
pinned `packageManager`, and its own CI. Cloning it alone is enough to install, build,
test and deploy. Nothing resolves upward into the `spark-parking` umbrella repo.

## Layout

```
src/                            — the Nest application
prisma/                         — schema, migrations, dev seed
vendor/auth                     — IAuthProvider strategy (authjs | firebase | clerk | supabase)
vendor/maps                     — IMapProvider strategy (google | mapbox)
vendor/notifications            — IEmailProvider / IPushProvider strategies
vendor/payments                 — IPaymentProvider strategy (stripe | mock)
vendor/subscription-billing     — ISubscriptionBillingProvider strategy
vendor/types                    — shared TypeScript types, zero runtime dependencies
vendor/config                   — shared tsconfig and eslint bases
```

`vendor/*` are pnpm workspace members (see `pnpm-workspace.yaml`), linked with
`workspace:*`. They are real packages: each has its own `package.json`, builds to `dist/`
with `tsc`, and owns its own tests.

`pnpm run build` and `dev` run `pnpm -r run build` first, so every `vendor/*` package
compiles in dependency order before Nest builds. `test` and `typecheck` likewise run
`pnpm -r` first — **the vendored packages' suites are part of this repo's test run**
(auth, maps, payments and subscription-billing carry ~220 tests between them).

### vendor/types is duplicated with apps/web

`vendor/types` exists in both this repo and the web repo, deliberately, so neither depends
on the other. It is the one contract that can silently drift. When you change auth roles,
the password policy, or payment/booking status shapes here, make the same change in
`spark-parking-web`'s `vendor/types` in the same PR.

## Strategy patterns

### Auth

- Never import a provider SDK directly in app code.
- Inject `AuthContext` via `@spark/auth`. Call `createAuthContext(config)` at bootstrap.
- Switch provider: change `AUTH_PROVIDER` env var. No code change.
- New provider: implement `IAuthProvider`, add to `AuthFactory.ts`, add a config union branch.

### Maps

- Never import a maps SDK directly in app code.
- Inject `MapContext` via `@spark/maps`. Call `createMapContext(config)` at bootstrap.
- Switch provider: change `MAP_PROVIDER` env var. No code change.
- New provider: implement `IMapProvider`, add to `MapFactory.ts`, add a config union branch.

Payments, subscription billing and notifications follow the same interface + factory +
env-var shape.

## Implementation workflow

### 1. Evaluate

- Understand full scope: inputs, outputs, affected modules, edge cases.
- Find security surface (auth, input validation, PII, payments, concurrency).
- Find performance surface (DB queries, network calls, cache candidates).
- Flag ambiguity before start. No assume.

### 2. Search existing patterns

- Grep the codebase for similar work before designing anything new.
- Check `vendor/` for reusable abstractions already there.
- Check existing service/module structure in `src/` for conventions.
- Never reinvent what exists. Extend it.

### 3. Design the solution

- Pick the simplest approach that satisfies correctness, security, performance.
- Prefer existing patterns (strategy, factory, NestJS module/service/controller layering).
- Define error handling: which errors expected, which fatal, what the client gets.
- Define security controls: where validation happens, what is authorized, what is logged.
- Write the plan as a task list before touching files.

### 4. Implement

- Follow the plan. No scope creep.
- One concern per file. Keep modules thin.
- Error handling at boundaries only. No defensive wrapping of internal calls unless they
  genuinely fail in new ways.
- No dead code, no TODO comments, no half-finished stubs.

### 5. Subagent and model selection

| Task type                                                                                       | Model               |
| ----------------------------------------------------------------------------------------------- | ------------------- |
| Complex implementation — auth flows, payment logic, booking engine, concurrency, security paths | `opus`              |
| Standard implementation — CRUD endpoints, module wiring, migrations, config                     | `sonnet`            |
| Search, file discovery, pattern matching, reading code to answer a question                     | `sonnet` or `haiku` |

- Use `opus` when the task involves security decisions, race conditions, financial logic,
  or architectural trade-offs.
- Use `haiku` only for pure read/search, with no output written to source.
- Spawn parallel subagents only for independent tasks touching different files.
- Never parallelize tasks writing the same module or depending on each other's output.

## Coding standards

- TypeScript strict mode everywhere. No `any` without explicit justification.
- No comments unless the WHY is non-obvious.
- Zod for all external input validation (request bodies, env vars, webhook payloads).
- No `console.log` in production paths. Use the structured logger (pino).
- `type-imports` enforced: `import type { Foo }` for type-only imports.

## Security rules

- Validate all inputs with Zod before use.
- Authorization checks in both controller and service layer.
- Rate-limit: search, login, OTP and booking endpoints.
- Idempotency keys on payment and booking confirmation.
- Never log raw tokens, passwords or PII.
- Webhook payloads must be cryptographically verified before processing.
- No secrets in source. Use `.env.example` only; `.env` is gitignored.
- Admin endpoints are never exposed in client bundles.
- Prevent overbooking via DB transactions + row-level locking.

## Module boundary rules

- `vendor/*` must not import from `src/`. Dependencies point one way only.
- `vendor/types` must have zero runtime dependencies.
- `vendor/auth`, `vendor/maps`, `vendor/notifications`, `vendor/payments` and
  `vendor/subscription-billing` depend only on `@spark/types`.
- Never reach outside this repo.

## Administrative tiers

| Role             | May do                                                                        |
| ---------------- | ----------------------------------------------------------------------------- |
| `PLATFORM_ADMIN` | Every `platform:*` capability — tenants, facilities, tariffs, billing, purges |
| `SUPER_ADMIN`    | All of the above, plus the `identity:*` family: read, re-role and run the     |
|                  | lifecycle on user ACCOUNTS                                                    |

The two tiers are separated by the `identity:*` permissions in `vendor/types/src/auth.ts`
and nothing else. The lifecycle surface (`/admin/lifecycle/:resourceType/...`) is generic
over its resource type and `user` is one of the four, so **the per-resource-type check in
`LifecycleAdminService` and `AdminLifecycleController` is the entire boundary**. Treat any
change to it as security-critical and re-run the boundary tests.

`identity:admin.invite` is the one deliberate exception: platform admins hold it so they
can recruit a peer, and it grants no visibility into any account.

## Local setup

```bash
pnpm install
cp .env.example .env
# fill in at least AUTH_PROVIDER and MAP_PROVIDER, plus MOCK_WEBHOOK_SECRET
# (required whenever PAYMENT_PROVIDER=mock, which is the default)
pnpm run db:migrate
pnpm run db:seed:dev          # demo operators, facilities, dashboard accounts
pnpm run dev
```

Postgres (PostGIS) and Redis come from the `docker-compose.yml` in the `spark-parking`
umbrella repo (`docker compose up -d`). If you cloned this repo alone, run equivalents:

```bash
docker run -d --name spark-postgres -p 5432:5432 \
  -e POSTGRES_USER=spark -e POSTGRES_PASSWORD=spark -e POSTGRES_DB=spark \
  postgis/postgis:16-3.5-alpine
docker run -d --name spark-redis -p 6379:6379 redis:7-alpine
```

PostGIS specifically, not stock postgres: the migration chain runs `CREATE EXTENSION
postgis` and the schema's GENERATED geography columns need the extension at apply time.

The API validates its environment at boot and fails with an aggregated list of every
missing var, so a misconfigured `.env` surfaces immediately rather than at first request.

`db:generate` is not run by any build script and pnpm may skip postinstall scripts, so
run it after a fresh install or `typecheck`/`test` will fail against an ungenerated client.

## Bootstrapping a real environment

`db:seed:dev` is development-only: it writes demo accounts that share a password committed
to this repository, and refuses to run when `NODE_ENV=production`. Create the first super
administrator on a real database with the one-shot bootstrap CLI instead:

```bash
BOOTSTRAP_ADMIN_EMAIL=admin@yourdomain.gr pnpm run bootstrap:admin
```

It creates a single `SUPER_ADMIN` with a random password printed once to stdout, and
refuses to run if any super admin already exists — a bootstrap, not a way to mint admins.
Sign in and change the password immediately. Every account after the first comes from the
operator invite flow, which requires an existing platform admin.

### Re-registering an address that was purged

Purging a user anonymises the row and destroys the identity-provider credential, so the
address is genuinely free afterwards and can be invited again. Purges that ran **before**
that release path existed left the credential behind, and the address stays registered
with Google forever — a fresh invite to it then dies at signUp with
`auth/email-already-exists`. Repair those with the one-shot reconcile CLI:

```bash
pnpm run reconcile:purged someone@example.com
```

It reports and changes nothing without `--apply`. Two halves: operator memberships still
held by `PURGED` accounts are derived from the database and need no arguments; stranded
credentials cannot be derived (purge nulls `firebaseUid` and rewrites the email) so the
addresses are named on the command line. An address a local account still owns — in **any**
lifecycle state — is skipped rather than released, because destroying a live person's
credential locks them out with no way back.

### Upgrading a deployment that already has platform admins

There is deliberately **no data migration that promotes existing accounts**. A migration
cannot tell which `PLATFORM_ADMIN` was the bootstrap owner and which arrived through an
invite, so promoting automatically would silently hand account-deletion powers to everyone
who already had the role — the exact escalation this tier exists to prevent.

Instead: the CLI counts `SUPER_ADMIN` accounts, not `PLATFORM_ADMIN` ones, so on an
upgraded database that count is zero and the command simply runs. Bootstrap the first
super admin against a **fresh email address** (the CLI refuses to promote an existing
account for the same reason), then use it to grant the role to whoever should hold it.

## Env var conventions

Everything here is server-side only and must never be exposed to a client bundle. There is
no public prefix in this repo. Never hand a service role key or private key to the web or
mobile apps.

## Deploy

`Dockerfile` builds from this repo alone — no monorepo context. CI builds the image on
every run so a broken Dockerfile fails the PR rather than the deploy.

## Definition of done

- [ ] Feature acceptance criteria implemented
- [ ] Unit and integration tests added
- [ ] `pnpm run lint && pnpm run typecheck && pnpm run test` all pass
- [ ] No secrets introduced
- [ ] Security-sensitive changes reviewed by a fresh subagent
- [ ] Observability hooks added for critical flows
- [ ] `.env.example` updated if new env vars added
- [ ] `vendor/types` change mirrored into `spark-parking-web` if the contract moved

## Branch and commit discipline

- Feature branches off `main`.
- Commits: `type(scope): message` — e.g. `feat(auth): add clerk provider`.
- No direct pushes to `main`.
- All PRs require passing CI.
