import type { AgentEvent } from "./events";
import type { RunContext, TaskGraph, ToolResult } from "./types";

export interface ExecuteOptions {
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onWaveComplete?: (completedCount: number) => boolean | void | Promise<boolean | void>;
}

export async function execute(
  ctx: RunContext,
  graph: TaskGraph,
  opts: ExecuteOptions = {}
): Promise<ToolResult[]> {
  const done = new Map<string, ToolResult>();
  const remaining = [...graph.tasks];
  const emit = opts.onEvent
    ? async (e: AgentEvent) => {
        try {
          await opts.onEvent!(e);
        } catch {
          // sink errors must never stall the orchestrator
        }
      }
    : null;

  while (remaining.length) {
    const ready = remaining.filter((t) => (t.dependsOn ?? []).every((d) => done.has(d)));

    if (ready.length === 0) {
      for (const t of remaining) {
        const now = new Date();
        const result: ToolResult = {
          taskId: t.id,
          tool: t.tool,
          ok: false,
          output: null,
          error: "unresolved or cyclic dependency",
          startedAt: now,
          finishedAt: now,
        };
        done.set(t.id, result);
        if (emit) {
          await emit({
            type: "tool_end",
            taskId: t.id,
            tool: t.tool,
            ok: false,
            output: null,
            error: result.error,
          });
        }
      }
      break;
    }

    if (emit) {
      for (const t of ready) {
        await emit({
          type: "tool_start",
          taskId: t.id,
          tool: t.tool,
          input: t.input,
        });
      }
    }

    const wave = await Promise.all(
      ready.map(async (t): Promise<ToolResult> => {
        const startedAt = new Date();
        let externalUnits: number | undefined;
        let externalCostUsd: number | undefined;
        try {
          const output = await ctx.registry.run(t.tool, t.input, {
            tenantId: ctx.tenantId,
            meter: (input: { units?: number; costUsd?: number }) => {
              if (typeof input.units === "number" && Number.isFinite(input.units)) {
                externalUnits = (externalUnits ?? 0) + input.units;
              }
              if (typeof input.costUsd === "number" && Number.isFinite(input.costUsd)) {
                externalCostUsd = (externalCostUsd ?? 0) + input.costUsd;
              }
            },
          });
          return {
            taskId: t.id,
            tool: t.tool,
            ok: true,
            output,
            startedAt,
            finishedAt: new Date(),
            externalUnits,
            externalCostUsd,
          };
        } catch (e) {
          return {
            taskId: t.id,
            tool: t.tool,
            ok: false,
            output: null,
            error: String(e),
            startedAt,
            finishedAt: new Date(),
            externalUnits,
            externalCostUsd,
          };
        }
      })
    );

    for (const r of wave) {
      done.set(r.taskId, r);
      if (emit) {
        await emit({
          type: "tool_end",
          taskId: r.taskId,
          tool: r.tool,
          ok: r.ok,
          output: r.output,
          error: r.error,
        });
      }
    }
    for (const t of ready) remaining.splice(remaining.indexOf(t), 1);

    if (opts.onWaveComplete) {
      const shouldContinue = await opts.onWaveComplete(done.size);
      if (shouldContinue === false) break;
    }
  }

  return graph.tasks.map(
    (t) =>
      done.get(t.id) ?? {
        taskId: t.id,
        tool: t.tool,
        ok: false,
        output: null,
        error: "not executed",
        startedAt: new Date(),
        finishedAt: new Date(),
      }
  );
}
