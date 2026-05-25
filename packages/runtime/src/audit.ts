import type { SupabaseClient } from "@supabase/supabase-js";

export type AuditSeverity = "debug" | "info" | "warn" | "error" | "critical";

export interface AuditEventInput {
  tenantId?: string | null;
  event: string;
  severity: AuditSeverity;
  subject?: string;
  meta?: Record<string, unknown>;
}

export class AuditBatch {
  private queue: AuditEventInput[] = [];

  constructor(private supabase: SupabaseClient) {}

  push(evt: AuditEventInput): void {
    this.queue.push(evt);
  }

  async flush(): Promise<void> {
    for (const evt of this.queue) {
      try {
        const { error } = await this.supabase.rpc("record_audit_event", {
          p_tenant: evt.tenantId ?? null,
          p_event: evt.event,
          p_severity: evt.severity,
          p_subject: evt.subject ?? null,
          p_meta: evt.meta ?? {},
        });
        if (error) {
          console.warn("audit flush RPC failed:", error.message);
        }
      } catch (error) {
        console.warn("audit flush threw:", error);
      }
    }
    this.queue = [];
  }
}
