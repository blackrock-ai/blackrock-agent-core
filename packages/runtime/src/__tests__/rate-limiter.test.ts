import { describe, expect, test } from "bun:test";
import { checkRateLimit } from "../rate-limiter";

describe("checkRateLimit", () => {
  test("returns ok=true when RPC allows", async () => {
    const supabase = {
      rpc: async () => ({ data: true, error: null }),
    };

    const out = await checkRateLimit({
      // any: minimal mock for Supabase RPC surface.
      supabase: supabase as any,
      tenantId: "t1",
      subject: "tenant:t1",
      windowSecs: 60,
      limit: 60,
    });

    expect(out.ok).toBeTrue();
    expect(out.retryAfterSec).toBeUndefined();
  });

  test("returns retryAfterSec when RPC denies", async () => {
    const supabase = {
      rpc: async () => ({ data: false, error: null }),
    };

    const out = await checkRateLimit({
      // any: minimal mock for Supabase RPC surface.
      supabase: supabase as any,
      tenantId: "t1",
      subject: "tenant:t1",
      windowSecs: 60,
      limit: 1,
    });

    expect(out.ok).toBeFalse();
    expect((out.retryAfterSec ?? 0) > 0).toBeTrue();
    expect((out.retryAfterSec ?? 0) <= 60).toBeTrue();
  });

  test("fails open on RPC error", async () => {
    const supabase = {
      rpc: async () => ({ data: null, error: { message: "boom" } }),
    };

    const out = await checkRateLimit({
      // any: minimal mock for Supabase RPC surface.
      supabase: supabase as any,
      tenantId: "t1",
      subject: "tenant:t1",
      windowSecs: 60,
      limit: 1,
    });

    expect(out.ok).toBeTrue();
  });
});
