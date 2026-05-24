# Agent Core — Master Architecture & File Manifest

**Repo:** `github.com/blackrock-ai/blackrock-agent-core`
**Branch:** `main` · **Head:** `2d9a733`
**Status:** Core built through Sprint 4 (merged, verified). Sprints 5–6 remaining.
**Last updated:** 2026-05-24

This is the start-to-finish blueprint for Agent Core — every file that exists today, every file the remaining two sprints add, and how the whole thing fits together. It is the reference the Sprint 5 briefing is written against. It belongs in the repo at `docs/architecture.md`.

> File purposes below are derived from the verified file inventory (`agent-core-inventory.txt`, 2026-05-24) and the build directive. The Sprint 5 discovery pass confirms each against actual code before any work begins.

---

## 1. What Agent Core is

Agent Core is a **reusable, config-driven AI agent workspace** — built once, embedded into every BlackRock AI client app. It is a package library, not an application: it has no standalone deployment, no URL, no users of its own. A client app installs it, supplies a per-client config, and gets an embedded AI command-center surface backed by an agent runtime that lives in that client's own infrastructure.

The architecture follows the Genspark pattern: one orchestrator running a **planner → executor → synthesizer → critic** loop, plus a **tool registry** where every capability is a registered tool. Multi-tenant from the schema up — `tenant_id` and RLS on every table, per-tenant credentials in Supabase Vault.

The first install target is **BlackRock AI itself** — tenant #1 — into the `blackrock-command-center` app.

---

## 2. Architecture

### The four packages

| Package | npm name | Role | Deploys to |
| --- | --- | --- | --- |
| **shell** | `@blackrock-ai/agent-core` | Embeddable React workspace UI | Client app's web frontend |
| **runtime** | `@blackrock-ai/agent-runtime` | Orchestrator — planner/executor/synthesizer/critic, streaming, persistence, OAuth | Client's Supabase Edge Functions |
| **tools** | `@blackrock-ai/agent-tools` | Tool registry + built-in tools | Imported by runtime |
| **schema** | `@blackrock-ai/agent-schema` | Database migrations + verification scripts | Client's Supabase Postgres |

Dependency direction (after the Sprint 5 fix): `schema` depends on nothing → `tools` → `runtime` → `shell`. Clean bottom-up stack.

### How a request flows

1. A user types a request in the **shell** (`Workspace.tsx`); `client.ts` opens an SSE connection to the agent Edge Function.
2. The **runtime** `handler.ts` receives it, `context.ts` loads the tenant context (service-role client, tenant credentials from Vault).
3. The orchestrator loop runs: `planner.ts` builds a task graph → `executor.ts` runs it, dispatching **tools** from the registry → `synthesizer.ts` assembles the answer → `critic.ts` verifies it.
4. `model.ts` makes the Anthropic/OpenAI calls and captures token usage/cost.
5. `persistence.ts` writes the run and messages to the database; the SSE stream returns `plan` / `tool_*` / `token` / `verified` / `done` events to the shell.

### The install model

Per client: install the four packages, apply the migrations into the client's Supabase (namespaced into a dedicated `agent_core` Postgres schema), deploy the `agent` Edge Function, write one `agent.config.ts`, mount `<Workspace/>` on a route. The client uses their own API keys and their own Supabase project — their data, their bill, full isolation.

---

## 3. Build status — the six sprints

| Sprint | Scope | Status |
| --- | --- | --- |
| 1 | Credential & Tenant Foundation | ✅ Built, merged, verified |
| 2 | Core Tool Catalog | ✅ Built, merged, verified |
| 3 | Streaming & Chat Surface | ✅ Built, merged, verified |
| 4 | Connected Integrations (OAuth) | ✅ Built, merged, verified |
| — | Remediation 1 & 2 (migrations, run persistence, verify scripts) | ✅ Built, merged, verified |
| 5 | Install Pipeline + BlackRock install | ⏳ Not started — next |
| 6 | Metering, Admin & Hardening | ⏳ Not started |

Core source today: **67 files, ~6,713 lines.**

---

## 4. The file manifest — what exists (Sprints 1–4)

### Root

| File | Status | Purpose |
| --- | --- | --- |
| `package.json` | BUILT | Root workspace — Bun workspaces, build/typecheck scripts |
| `tsconfig.base.json` | BUILT | Shared strict TypeScript config, extended by each package |
| `.npmrc` | BUILT | Registry config — **rewritten in Sprint 5 for `@blackrock-ai` scope** |
| `.gitignore` | BUILT | Standard ignores |
| `bun.lock` | BUILT | Lockfile |
| `README.md` | BUILT | Repo readme |

### `cli/`

| File | Status | Purpose |
| --- | --- | --- |
| `cli/install.sh` | BUILT (stub) | Current installer — **rebuilt in Sprint 5 into the real generic installer** |

### `examples/`

| File | Status | Purpose |
| --- | --- | --- |
| `examples/client-config.example.ts` | BUILT | Template per-client config (brand, accent, nav, tool list) |
| `examples/README.md` | BUILT | How to use the example config |

### `packages/shell/` — `@blackrock-ai/agent-core`

| File | Status | Purpose |
| --- | --- | --- |
| `package.json` | BUILT | Package manifest — **scope renamed in Sprint 5** |
| `tsconfig.json` · `tsup.config.ts` | BUILT | Build config — dual CJS/ESM via tsup |
| `src/index.ts` | BUILT | Package entry — exports `Workspace` and config types |
| `src/Workspace.tsx` | BUILT | The embeddable workspace UI component |
| `src/client.ts` | BUILT | Client-side API client — calls the agent Edge Function, consumes the SSE stream |
| `src/types.ts` | BUILT | Shell types — the per-client config shape |
| `src/__tests__/client.test.ts` | BUILT | Client tests |

### `packages/runtime/` — `@blackrock-ai/agent-runtime`

| File | Status | Purpose |
| --- | --- | --- |
| `package.json` | BUILT | Package manifest — **scope renamed in Sprint 5** |
| `tsconfig.json` · `tsup.config.ts` | BUILT | Build config |
| `src/index.ts` | BUILT | Package entry — exports `createAgentHandler` |
| `src/handler.ts` | BUILT | The SSE streaming HTTP handler; run lifecycle; **schema-refactored in Sprint 5** |
| `src/context.ts` | BUILT | `loadTenantContext` — service-role client, tenant credentials; **schema-refactored in Sprint 5** |
| `src/planner.ts` | BUILT | Decomposes a task into a plan / task graph |
| `src/executor.ts` | BUILT | Runs the plan, dispatches tools |
| `src/synthesizer.ts` | BUILT | Assembles the final answer |
| `src/critic.ts` | BUILT | Reviews and verifies the output — the loop's quality gate |
| `src/model.ts` | BUILT | Anthropic/OpenAI model calls; token + cost capture |
| `src/persistence.ts` | BUILT | Writes `agent_runs` / `agent_messages`; **schema-refactored in Sprint 5** |
| `src/oauth.ts` | BUILT | OAuth flow — token exchange, refresh, Vault storage; **schema-refactored in Sprint 5** |
| `src/events.ts` | BUILT | SSE event type definitions |
| `src/types.ts` | BUILT | Runtime types — `RunContext` and friends |
| `src/__tests__/events.test.ts` | BUILT | Event-schema tests |
| `src/__tests__/oauth.test.ts` | BUILT | OAuth tests |

### `packages/tools/` — `@blackrock-ai/agent-tools`

| File | Status | Purpose |
| --- | --- | --- |
| `package.json` | BUILT | Package manifest — **scope renamed in Sprint 5** |
| `tsconfig.json` · `tsup.config.ts` | BUILT | Build config |
| `src/index.ts` | BUILT | Package entry — exports the registry and built-ins |
| `src/registry.ts` | BUILT | The tool registry — register/lookup |
| `src/builtins/web-search.ts` | BUILT | Web search tool |
| `src/builtins/http-request.ts` | BUILT | Generic HTTP request tool |
| `src/builtins/data-query.ts` | BUILT | Read-only database query tool |
| `src/builtins/doc-generate.ts` | BUILT | Document generation tool |
| `src/builtins/hubspot-query.ts` | BUILT | HubSpot integration tool |
| `src/builtins/m365-mail.ts` | BUILT | Microsoft 365 mail tool |
| `src/builtins/_connections.ts` | BUILT | Shared credential/connection helper for connected tools |
| `src/builtins/__tests__/*.test.ts` | BUILT | Tests — `data-query`, `doc-generate`, `hubspot-query`, `m365-mail`, `web-search` |

### `packages/schema/` — `@blackrock-ai/agent-schema`

| File | Status | Purpose |
| --- | --- | --- |
| `package.json` | BUILT | Package manifest — **scope renamed + circular dependency removed in Sprint 5** |
| `tsconfig.json` | BUILT | TS config for the scripts |
| `migrations/0001_agent_core.sql` | BUILT | Core tables — tenants, runs, messages, `current_tenant()`, RLS; **namespaced to `agent_core` schema in Sprint 5** |
| `migrations/0002_credential_resolution.sql` | BUILT | `tenant_credentials`, Vault `secret_ref` resolution; **namespaced in Sprint 5** |
| `migrations/0003_artifacts_storage.sql` | BUILT | Artifacts storage pointer table + bucket policies; **namespaced in Sprint 5** |
| `migrations/0004_read_only_query_path.sql` | BUILT | Server-side read-only query path for the data-query tool; **namespaced in Sprint 5** |
| `migrations/0005_run_lifecycle.sql` | BUILT | Run status lifecycle + token/cost columns; **namespaced in Sprint 5** |
| `migrations/0006_oauth_connections.sql` | BUILT | `oauth_connections` table for connected integrations; **namespaced in Sprint 5** |
| `scripts/bootstrap-tenant.ts` | BUILT | Creates a tenant row + credential records |
| `scripts/verify-migrations.sh` | BUILT | Verifies migrations apply cleanly in order |
| `scripts/verify-isolation.ts` | BUILT | Verifies tenant RLS isolation |
| `scripts/verify-tools.ts` | BUILT | Verifies tool-catalogue invariants |
| `scripts/verify-streaming.ts` | BUILT | Verifies SSE schema + persisted runs |
| `scripts/verify-connections.ts` | BUILT | Verifies the OAuth surface |
| `scripts/verify-persistence-live.sh` | BUILT | Verifies run/message persistence against a live DB |

### `supabase/`

| File | Status | Purpose |
| --- | --- | --- |
| `supabase/functions/oauth/index.ts` | BUILT | OAuth callback Edge Function |

---

## 5. Sprint 5 — Install Pipeline (files added / changed)

Sprint 5 has three parts. It runs as an autoloop in `blackrock-agent-core` only — it never touches the Command Center repo or its Supabase project.

### Part A — Runtime schema namespacing

Makes "install into any app without a table collision" actually true. Agent Core's tables move into a dedicated `agent_core` Postgres schema; the runtime is refactored to target it.

| File | Change |
| --- | --- |
| `migrations/0001`–`0006` | CHANGED — every table, function, index, policy, trigger and type namespaced into schema `agent_core`; all cross-references schema-qualified; function bodies and RLS expressions schema-qualified or given an explicit `search_path`; RLS preserved |
| `runtime/src/constants.ts` | NEW — defines `AGENT_CORE_SCHEMA = 'agent_core'` as the single TS-side source of truth (the migrations hardcode the same name in SQL; the `schema` package stays migrations-only and non-buildable) |
| Runtime + tools DB-touching files | CHANGED — every file that creates a Supabase client or queries an `agent_core` table targets the schema. The exact list is produced by the Sprint 5 discovery pass, not guessed — it spans **both** the runtime package (`context.ts`, `persistence.ts`, `oauth.ts`, and any others) **and** the tools package (`data-query.ts`, `_connections.ts`, and any others) |
| `schema/scripts/verify-*` | CHANGED — assertions updated to the `agent_core` schema |

### Part B — Publish preparation

| File | Change |
| --- | --- |
| All 4 `package.json` | CHANGED — `@blackrock/*` → `@blackrock-ai/*`; cross-refs updated; `prepublishOnly` build hooks; `repository` field |
| `packages/schema/package.json` | CHANGED — circular dependency removed (schema depends on nothing) |
| `.npmrc` | CHANGED — `@blackrock-ai` scope → GitHub Packages registry |
| `cli/release.sh` | NEW — the watched publish runbook (prep verified; Brian runs `npm publish`) |

### Part C — The generic installer

| File | Change |
| --- | --- |
| `cli/install.sh` | REBUILT — the real installer: preflight, package install, migration prepare+apply, Edge Function deploy, config scaffold, `<Workspace/>` mount, target `.npmrc` setup, exposed-schema registration, post-install verify; idempotent, `--dry-run` |
| `cli/preflight.sh` | NEW — verifies target repo structure, Supabase connectivity, Vault, a `read:packages` token, and that no `agent_core` schema already exists |
| `cli/prepare-migrations.ts` | NEW — reads `agent-schema`'s migrations (already `agent_core`-scoped from Part A), reconciles against the target's **live** migration state, renumbers and renames them into the target's `NNN_` sequence, writes them into the target's `supabase/migrations/` |
| `cli/mount-shell.ts` | NEW — generates the `<Workspace/>` mount snippet and the `agent.config.ts` scaffold for the host app |
| `cli/install.config.example` | NEW — install manifest template (target repo, tenant slug, Supabase ref, web dir, migration numbering) |
| `docs/architecture.md` | NEW — this document, committed to the repo |
| `docs/agent-core-build-directive.md` | NEW — the build directive, committed to the repo |
| `docs/install-runbook.md` | NEW — the watched runbook for the Command Center install |

### Sprint 5 deliverables that are *not* code in this repo

- The four packages **published** to GitHub Packages under `@blackrock-ai/*` — autoloop preps everything publish-ready; **Brian runs `npm publish` watching** (publishing is permanent).
- The **Command Center install** itself — performed by Brian by hand against `gsvhuzpysxaegoecwjmf`, following `docs/install-runbook.md`, with a fresh backup taken first. Not autoloop'd into the live project.

---

## 6. Sprint 6 — Metering, Admin & Hardening (scoped at intent level)

Decomposed in detail by the orchestrator when Sprint 6 begins. Likely files:

| Area | Likely files |
| --- | --- |
| Metering | `migrations/0007_metering.sql` (usage rollup views), runtime metering module, aggregation queries over `agent_runs` |
| Admin | Shell admin components — per-tenant usage dashboard, tenant management, tool toggles |
| Hardening | Rate-limiting middleware in `handler.ts`; the `oauth_states` sweeper cron (deferred from Remediation 2); a security pass |

After Sprint 6, the core is complete: a finished, published product with a proven installer and zero client entanglement.

---

## 7. Audit findings & resolutions

The 2026-05-24 repo audit surfaced four items:

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | Packages named `@blackrock/*` — cannot publish (no `blackrock` GitHub org) | ✅ Resolved — `blackrock-ai` org created, repo transferred. Scope is `@blackrock-ai/*`. Sprint 5 Part B does the rename. |
| 2 | `agent-schema` has an inverted dependency (depends on shell + runtime + tools) | Sprint 5 Part B — schema depends on nothing |
| 3 | `cli/install.sh` is a stub — raw `cp` of migrations would collide on numbering and on `public.agent_runs` in any mature host app | Sprint 5 Part C — the real namespacing installer |
| 4 | No `docs/` folder — build directive and briefings never committed to the repo | Sprint 5 Part C — `docs/` created and populated |

### Blockers — all resolved

| Blocker | Resolution |
| --- | --- |
| npm scope | `@blackrock-ai/*` — org created, repo transferred, local remote repointed |
| Publish auth | Classic PAT with `write:packages` — in hand. Autoloop preps; Brian publishes watched. |
| Command Center Supabase | Project ref `gsvhuzpysxaegoecwjmf`; `supabase_vault` extension confirmed enabled |

### Two things Sprint 5's installer must handle

1. **Live migration state.** The Command Center Supabase project's deployed migration state is **ahead of** the repo's `supabase/migrations/` folder (live last migration `telegram_notify_on_gate` is not in the repo's `001`–`028` list). The installer's preflight reconciles against the live `supabase_migrations.schema_migrations` table — never against an `ls` of the folder.

2. **GitHub Packages requires auth to install.** GitHub Packages' npm registry requires an authenticated token (`read:packages`) to install a package — even a public one. So the same token used to publish is needed again at install time, in the target repo's `.npmrc` / environment. The installer's preflight checks for it; the install runbook calls it out.

3. **PostgREST exposed schemas.** For the runtime's `supabase-js` client to query the `agent_core` schema over the API, `agent_core` must be added to the target project's exposed schemas (`supabase/config.toml` `[api].schemas`, plus the dashboard API settings). The installer registers it; Part A's local verification accounts for it.

---

## 8. The path from here

1. **Review this manifest.** It is the blueprint Sprint 5 is built against.
2. **Sprint 5 autoloop** — Parts A, B, C, in `blackrock-agent-core`. Ends with a merge gate.
3. **Publish** — Brian runs `npm publish` ×4, watched.
4. **Command Center install** — Brian runs the installer by hand against `gsvhuzpysxaegoecwjmf`, following `docs/install-runbook.md`. BlackRock becomes tenant #1.
5. **Sprint 6 autoloop** — metering, admin, hardening.
6. **Done.** Agent Core is a finished, published product. Every subsequent client (QEP, Redex, Lewis, Circle of Life) is a Client Install job using the proven installer — not a sprint of the core build.
