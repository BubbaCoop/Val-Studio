/**
 * The real runner.
 *
 * It drives the pipeline and nothing else. `/design <brief>` and `/design build
 * <run-dir>` are sent as PROMPT TEXT — verified: the CLI expands the command file and
 * reports it through the `UserPromptExpansion` hook as
 * `{ expansion_type: "slash_command", command_name: "design" }`. Nothing here writes a
 * brief, a concept, an approval or a manifest; every one of those belongs to a gate.
 *
 * Four things this file exists to get right, each learned from probing the SDK against
 * the real repo:
 *
 *   cwd            set to the target repo, which propagates to subagent tool calls.
 *                  Gate 0 check 5 compares `pwd` to the run directory and stops if they
 *                  differ; it passes, and records the comparison in the manifest.
 *   settings       `settingSources: ["project"]` — enough for .claude/agents/design-*
 *                  and .claude/commands/design.md (verified 5/5 agents and /design),
 *                  and NOT the operator's personal ~/.claude/settings.json. A run
 *                  driven by Studio is confined by Studio, not by whatever the operator
 *                  happens to have approved for themselves.
 *   confinement    a PreToolUse hook, because `canUseTool` is never consulted once
 *                  filesystem settings are loaded. The hook's deny overrides an
 *                  inherited allow.
 *   loop exit      a streaming session does NOT end at `result` — it waits for the next
 *                  user message. The loop breaks on `result` explicitly, or it hangs.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PreflightResult } from "@valiify/studio-shared";
import { runPreflight } from "./preflight.ts";
import { checkTool, type RunPolicy } from "./policy.ts";
import type { DesignRunner, RunnerInvocation, RunnerResult, RunnerUsage } from "./types.ts";

/** One user message, then an open stream: the session stays up until the turn ends. */
function promptStream(text: string): { stream: AsyncIterable<never>; close: () => void } {
  let release!: () => void;
  const closed = new Promise<void>((r) => (release = r));
  async function* stream(): AsyncGenerator<never> {
    yield {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    } as never;
    await closed;
  }
  return { stream: stream(), close: release };
}

function usageOf(result: { total_cost_usd?: number; modelUsage?: Record<string, Record<string, number>> }): RunnerUsage {
  const totals: RunnerUsage = {
    costUSD: result.total_cost_usd ?? 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    models: [],
  };
  for (const [model, u] of Object.entries(result.modelUsage ?? {})) {
    totals.models.push(model);
    totals.inputTokens += u.inputTokens ?? 0;
    totals.outputTokens += u.outputTokens ?? 0;
    totals.cacheReadTokens += u.cacheReadInputTokens ?? 0;
    totals.cacheCreationTokens += u.cacheCreationInputTokens ?? 0;
  }
  return totals;
}

export class AgentSdkRunner implements DesignRunner {
  readonly kind = "agent-sdk" as const;
  /** Pinned per run. The pipeline records the model on every gate and treats a mismatch as a finding. */
  model?: string;

  constructor(opts: { model?: string } = {}) {
    this.model = opts.model;
  }

  preflight(targetRepo: string): Promise<PreflightResult> {
    return runPreflight(targetRepo);
  }

  /** Gate 0 → Gate 4. The run directory is named by Gate 0, so writes are bounded by the runs root. */
  design(inv: RunnerInvocation): Promise<RunnerResult> {
    return this.#drive(inv, { targetRepo: inv.ctx.targetRepo, writeRoots: inv.ctx.writeRoots });
  }

  /** Gate 4b → Gate 7. The run directory is known exactly, so writes are bounded to it. */
  build(inv: RunnerInvocation): Promise<RunnerResult> {
    return this.#drive(inv, { targetRepo: inv.ctx.targetRepo, writeRoots: inv.ctx.writeRoots });
  }

  async #drive(inv: RunnerInvocation, policy: RunPolicy): Promise<RunnerResult> {
    const prompt = promptStream(inv.prompt);
    const abort = new AbortController();
    const onExternalAbort = () => abort.abort();
    inv.signal?.addEventListener("abort", onExternalAbort, { once: true });

    const refusals: { tool: string; reason: string }[] = [];
    let dispatched = false;
    let activeAgent: string | undefined;

    const q = query({
      prompt: prompt.stream,
      options: {
        abortController: abort,
        cwd: inv.ctx.targetRepo,
        // Project only: the repo's agents and commands, never the operator's settings.
        settingSources: ["project"],
        ...(this.model ? { model: this.model } : {}),
        hooks: {
          // Proof that the command file expanded rather than reaching the model as text.
          UserPromptExpansion: [
            {
              hooks: [
                async (input) => {
                  const i = input as { expansion_type?: string; command_name?: string };
                  if (i.expansion_type === "slash_command" && i.command_name === "design") dispatched = true;
                  return { continue: true };
                },
              ],
            },
          ],
          SubagentStart: [
            {
              hooks: [
                async (input) => {
                  const i = input as { agent_type?: string };
                  activeAgent = i.agent_type;
                  inv.onProgress?.({ agent: i.agent_type, text: `${i.agent_type} started` });
                  return { continue: true };
                },
              ],
            },
          ],
          SubagentStop: [
            {
              hooks: [
                async (input) => {
                  const i = input as { agent_type?: string };
                  inv.onProgress?.({ agent: i.agent_type, text: `${i.agent_type} finished` });
                  activeAgent = undefined;
                  return { continue: true };
                },
              ],
            },
          ],
          // The confinement. This is the only gate that actually holds.
          PreToolUse: [
            {
              hooks: [
                async (input) => {
                  const i = input as { tool_name: string; tool_input?: unknown; agent_type?: string };
                  const verdict = checkTool(policy, i.tool_name, i.tool_input);
                  if (verdict.allow) return { continue: true };
                  refusals.push({ tool: i.tool_name, reason: verdict.reason! });
                  inv.onProgress?.({ agent: i.agent_type ?? activeAgent, text: `refused ${i.tool_name}: ${verdict.reason}` });
                  return {
                    continue: true,
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: verdict.reason,
                    },
                  };
                },
              ],
            },
          ],
        },
      },
    });

    let finalText = "";
    let usage: RunnerUsage | undefined;
    let errored: string | undefined;

    try {
      for await (const msg of q) {
        if (msg.type === "assistant") {
          for (const block of (msg.message.content ?? []) as { type: string; text?: string }[]) {
            if (block.type === "text" && block.text) {
              finalText += block.text;
              inv.onProgress?.({ agent: activeAgent, text: block.text.slice(0, 200) });
            }
          }
        }
        if (msg.type === "result") {
          usage = usageOf(msg as never);
          if (msg.subtype !== "success") {
            errored = (msg as { result?: string }).result ?? msg.subtype;
          }
          // A streaming session waits for the next user message rather than ending.
          break;
        }
      }
    } catch (err) {
      errored = (err as Error).message;
    } finally {
      inv.signal?.removeEventListener("abort", onExternalAbort);
      prompt.close();
      try {
        await q.close?.();
      } catch {
        /* already closed */
      }
    }

    if (inv.signal?.aborted) {
      return { ok: false, error: "stopped by the operator", finalText: finalText.trim() || undefined, usage, refusals };
    }
    if (!dispatched && !errored) {
      // The command file did not expand. Everything downstream assumes it did, so this
      // is reported as a failure rather than passed off as a finished run.
      return {
        ok: false,
        error:
          "The /design command did not expand — the prompt reached the model as literal text. The target repo's .claude/commands/design.md was not loaded.",
        finalText: finalText.trim() || undefined,
        usage,
        refusals,
      };
    }
    if (errored) return { ok: false, error: errored, finalText: finalText.trim() || undefined, usage, refusals };
    return { ok: true, finalText: finalText.trim() || undefined, usage, refusals };
  }
}
