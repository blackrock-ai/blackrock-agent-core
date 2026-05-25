import { describe, expect, test } from "bun:test";
import { authorizeRuntimeTenant, decodeJwtClaimsFromAuthHeader } from "../auth";

function toBase64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bearerToken(claims: Record<string, unknown>): string {
  const header = toBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = toBase64Url(JSON.stringify(claims));
  return `Bearer ${header}.${payload}.sig`;
}

describe("decodeJwtClaimsFromAuthHeader", () => {
  test("reads tenant_id, role, sub claims", () => {
    const claims = decodeJwtClaimsFromAuthHeader(
      bearerToken({ tenant_id: "tenant-a", role: "authenticated", sub: "user-1" })
    );
    expect(claims?.tenant_id).toBe("tenant-a");
    expect(claims?.role).toBe("authenticated");
    expect(claims?.sub).toBe("user-1");
  });

  test("returns null for malformed header", () => {
    expect(decodeJwtClaimsFromAuthHeader("bad")).toBeNull();
  });
});

describe("authorizeRuntimeTenant", () => {
  test("rejects non-service tenant mismatch", () => {
    const headers = new Headers({
      authorization: bearerToken({ tenant_id: "tenant-a", role: "authenticated" }),
    });
    const out = authorizeRuntimeTenant("tenant-b", headers);
    expect(out.ok).toBeFalse();
    if (!out.ok) {
      expect(out.status).toBe(403);
      expect(out.error).toBe("forbidden: tenant mismatch");
    }
  });

  test("allows service role impersonation header", () => {
    const headers = new Headers({
      authorization: bearerToken({ role: "service_role" }),
      "x-agent-core-impersonate-tenant": "tenant-z",
    });
    const out = authorizeRuntimeTenant("tenant-a", headers);
    expect(out.ok).toBeTrue();
    if (out.ok) expect(out.tenantId).toBe("tenant-z");
  });
});
