/**
 * The real runner — preflight wired, run deliberately not.
 *
 * The preflight below is the verified part and runs for real. `design()` and
 * `build()` are intentionally unimplemented in this pass: the brief is to prove the
 * architecture before real agent runs are wired in, and a half-written driver that
 * looked like it worked would be worse than one that says it is not there.
 *
 * When it is wired, the shape is already fixed by the pipeline, not by us:
 *
 *   const q = query({
 *     prompt: stream,                       // `/design <brief-path>` sent as prompt TEXT
 *     options: {
 *       cwd: ctx.targetRepo,                // the run dir must be inside cwd (Gate 0)
 *       settingSources: ["user", "project", "local"],
 *     },
 *   });
 *
 * and the only thing read out of `q` is token-level progress. What stage the run is
 * in comes from the run directory watcher, never from the stream — which is what
 * makes a CLI-driven run exactly as observable as one Studio started.
 */
import type { PreflightResult } from "@valiify/studio-shared";
import { runPreflight } from "./preflight.ts";
import type { DesignRunner, RunnerInvocation, RunnerResult } from "./types.ts";

const NOT_WIRED =
  "The Agent SDK runner is not wired in this pass. The preflight is real; the run is not. " +
  "Start with --runner=stub (the default) to exercise the gates against a recorded run.";

export class AgentSdkRunner implements DesignRunner {
  readonly kind = "agent-sdk" as const;

  preflight(targetRepo: string): Promise<PreflightResult> {
    return runPreflight(targetRepo);
  }

  async design(_inv: RunnerInvocation): Promise<RunnerResult> {
    return { ok: false, error: NOT_WIRED };
  }

  async build(_inv: RunnerInvocation): Promise<RunnerResult> {
    return { ok: false, error: NOT_WIRED };
  }
}
