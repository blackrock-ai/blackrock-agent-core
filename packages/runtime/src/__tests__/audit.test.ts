import { describe, expect, test } from "bun:test";
import { AuditBatch } from "../audit";

describe("AuditBatch.flush", () => {
  test("writes events serially", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const supabase = {
      rpc: async (_name: string, args: Record<string, unknown>) => {
        calls.push(args);
        return { error: null };
      },
    };

    // any: minimal mock for Supabase RPC surface.
    const batch = new AuditBatch(supabase as any);
    batch.push({ tenantId: "t1", event: "e1", severity: "info" });
    batch.push({ tenantId: "t1", event: "e2", severity: "warn", meta: { x: 1 } });

    await batch.flush();

    expect(calls.length).toBe(2);
    expect(calls[0]?.p_event).toBe("e1");
    expect(calls[1]?.p_event).toBe("e2");
  });

  test("swallows errors", async () => {
    const supabase = {
      rpc: async () => ({ error: { message: "fail" } }),
    };

    // any: minimal mock for Supabase RPC surface.
    const batch = new AuditBatch(supabase as any);
    batch.push({ tenantId: "t1", event: "e1", severity: "info" });

    await expect(batch.flush()).resolves.toBeUndefined();
  });
});
