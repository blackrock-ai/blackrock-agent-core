import type { AgentEvent } from "./events";
import type { RunContext, TaskGraph, ToolResult } from "./types";

export interface ExecuteOptions {
  /**
   * Optional event sink. If provided, the executor emits `tool_start` /
   * `tool_end` events for each task as the dependency waves run. The callback
   * is awaited so streaming consumers can backpressure if they need to —
   * exceptions in the sink are swallowed so a broken consumer never stalls
   * the run.
   */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  /**
   * Called after each dependency wave with the total completed count.
   * Return false to stop executing additional waves.
   */
  onWaveComplete?: (completedCount: number) => boolean | void | Promise<boolean | void>;
}

/**
 * Runs the task graph in dependency waves. Independent tasks in a wave
 * run in parallel. Unresolved dependencies fail their tasks without
 * blocking the rest.
 */
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
    const ready = remaining.filter((t) =>
      (t.dependsOn ?? []).every((d) => done.has(d))
    );

    if (ready.length === 0) {
      for (const t of remaining) {
        const result: ToolResult = {
          taskId: t.id,
          tool: t.tool,
          ok: false,
          output: null,
          error: "unresolved or cyclic dependency",
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
        try {
          const output = await ctx.registry.run(t.tool, t.input, {
            tenantId: ctx.tenantId,
          });
          return { taskId: t.id, tool: t.tool, ok: true, output };
        } catch (e) {
          return {
            taskId: t.id,
            tool: t.tool,
            ok: false,
            output: null,
            error: String(e),
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
      }
  );
}
