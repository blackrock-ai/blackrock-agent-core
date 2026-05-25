# Sprint 6 — Locked Product Decisions

These five product decisions were made by Brian on 2026-05-24 between Phase 2 and Phase 3. They are now binding for the rest of Sprint 6 implementation. Recorded here so future contributors don't have to re-derive them.

## D1 — `agent_messages` retention: **90 days** (Option B)

- Raw `agent_messages` rows are auto-deleted after 90 days from `created_at`.
- Per-tenant override via `tenant_quotas.message_retention_days` (Phase 4 will surface in the admin UI; Phase 3 just adds the column).
- Daily pg_cron job `agent_core_prune_agent_messages` does the delete.
- Usage rollups are written from per-LLM-call detail BEFORE prune runs, so billing/analytics outlive raw message bodies.
- Cascade: deleting an `agent_runs` row drops its messages (already in place).

## D2 — `user_id` capture: **yes, capture JWT `sub`** (Option A)

- `handler.ts` extracts `jwt.sub` from the verified JWT and writes it to `agent_runs.user_id` on the initial INSERT.
- Service-role impersonation path leaves `user_id` null (no user identity behind a service-role call).
- The Phase 2 rate-limit subject `user:<sub>` already uses this value — making it queryable on `agent_runs` just exposes the same data.
- Per-user usage RPCs become possible in Phase 3 (`usage_summary` grouped by user_id when requested).
- Note: this introduces a soft PII signal (user identities). Document in install runbook so client operators can decide whether to surface per-user breakdowns in their installs.

## D3 — Per-tool $ policy: **LLM-only on invoices, per-tool exposed internally** (Option C)

- `tool_invocations.external_cost_estimate_usd` IS captured (Brave search, HubSpot rate-limit, M365 Graph, etc.).
- `usage_for_billing(tenant, month)` returns ONLY the LLM cost — `cost_usd` is the sum of `run_llm_calls.cost_usd` for the month.
- `usage_summary(tenant, from, to, grain)` accepts an optional `p_include_tools boolean default false` param. When true (admin-only), the response includes `tool_cost_usd` and per-tool breakdown.
- The admin RPC `admin_get_tool_usage(tenant, month)` (Phase 4) surfaces per-tool $ for ops/capacity planning.
- Public-facing billing line items stay simple: "AI usage: $X.YZ". Internal observability sees the full breakdown.

## D4 — Superadmin scoping: **cross-tenant, with audit-logged access** (Option C)

- The `admin_users` table (Phase 4) supports a `superadmin` role with NO `tenant_id` binding.
- Superadmins can read/write any tenant's data via the `is_admin()` RLS escape hatch.
- BUT every superadmin action that crosses tenant boundaries automatically logs an `audit_log` event:
  - `event = 'cross_tenant_access'`
  - `severity = 'info'` (read) or `'warn'` (write)
  - `meta = { actor_user_id, accessed_tenant_id, operation, resource }`
- The admin UI (Phase 4) surfaces a "Cross-tenant access log" panel that each tenant can view — they see exactly when BlackRock staff touched their data, what they did, who they were.
- Tamper-evidence: `audit_log` is append-only (revoke update/delete from all non-postgres roles) — already in place from Phase 2's migration 0011.

## D5 — Auth Hook tier: **5a — verify gsvhuzpysxaegoecwjmf is Pro** (manual dashboard check)

- Pre-token-issued Auth Hooks are required by Phase 4's `auth-jwt` Edge Function (it merges `tenant_id` + `admin_role` into JWT custom claims).
- Auth Hooks are a Supabase **Pro** feature.
- **Action for Brian (pre-Phase 4):** verify gsvhuzpysxaegoecwjmf is on Pro tier at:
  https://supabase.com/dashboard/project/gsvhuzpysxaegoecwjmf/settings/billing
- If yes → Phase 4 proceeds as designed.
- If no → upgrade to Pro before Phase 4, OR fall back to JWT custom claims set via service-role on user create/update (less elegant; doable but adds an admin RPC).
- 5b (policy for future client installs requiring Pro tier) is **deferred** — to be decided when the second client (QEP/Redex/Lewis/Circle of Life) onboards.

---

**Audit trail:** decisions captured live during the Sprint 6 Phase 2 → Phase 3 transition.
