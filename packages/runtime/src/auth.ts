export interface JwtClaims {
  tenant_id?: string;
  role?: string;
  sub?: string;
  admin_role?: string;
}

/**
 * Supabase Edge already verifies JWT signatures before invoking our function.
 * We only decode the payload segment to read claims for authorization checks.
 */
export function decodeJwtClaimsFromAuthHeader(authHeader: string | null): JwtClaims | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1]?.trim();
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (!payload) return null;

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const decoded = atob(padded);
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    return {
      tenant_id: typeof parsed.tenant_id === "string" ? parsed.tenant_id : undefined,
      role: typeof parsed.role === "string" ? parsed.role : undefined,
      sub: typeof parsed.sub === "string" ? parsed.sub : undefined,
      admin_role: typeof parsed.admin_role === "string" ? parsed.admin_role : undefined,
    };
  } catch {
    return null;
  }
}

export type TenantAuthorizationResult =
  | { ok: true; tenantId: string; claims: JwtClaims }
  | { ok: false; status: 401 | 403; error: string };

export function authorizeRuntimeTenant(
  bodyTenantId: string,
  headers: Headers,
): TenantAuthorizationResult {
  const claims = decodeJwtClaimsFromAuthHeader(headers.get("authorization")) ?? {};
  if (claims.role === "service_role") {
    const impersonatedTenant = headers.get("x-agent-core-impersonate-tenant")?.trim();
    return { ok: true, tenantId: impersonatedTenant || bodyTenantId, claims };
  }

  if (!claims.tenant_id) {
    return { ok: false, status: 401, error: "missing tenant_id claim" };
  }
  if (claims.tenant_id !== bodyTenantId) {
    return { ok: false, status: 403, error: "forbidden: tenant mismatch" };
  }

  return { ok: true, tenantId: bodyTenantId, claims };
}
