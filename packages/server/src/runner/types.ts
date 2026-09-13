/**
 * The runner interface — the seam a hosted runner slots into.
 *
 * Studio is a CLIENT of /design. A runner's whole job is to drive the pipeline and
 * let the run directory record what happened; it is emphatically NOT a place to
 * reimplement a gate. A runner never writes 01-brief.md, never writes a concept,
 * never writes 04-approval.md, never computes the approval hash, and never decides
 * that a gate passed — every one of those belongs to the pipeline.
 *
 * The pipeline is driven by sending `/design <brief-path>` as PROMPT TEXT: slash
 * commands are processed in the prompt stream, not through an API parameter.
 */
import type { PreflightResult } from "@valiify/studio-shared";

export interface RunnerContext {
  /** Absolute path to the target library repo. cwd for everything the runner spawns. */
  targetRepo: string;
  /** Absolute path to the run directory. */
  runDir: string;
  /** Path relative to the target repo — what `/design build <run-dir>` is invoked with. */
  runRelPath: string;
  runId: string;
  /**
   * Absolute directories this run may write into — the confinement bound, set by the
   * caller because only it knows the configured runs root.
   *
   * `build` gets the run directory alone. `design` gets the runs root plus the briefs
   * directory, because Gate 0 — not Studio — names the run directory, and narrowing
   * further would mean predicting a name the pipeline owns.
   */
  writeRoots: string[];
}

/** Token-level progress only. Never the record of which stage a run is in. */
export interface RunnerProgress {
  agent?: string;
  text?: string;
  tokens?: { input?: number; output?: number };
}

export interface RunnerInvocation {
  /** The literal prompt text, e.g. `/design val/briefs/brief-primary-contact.md --surface short-app`. */
  prompt: string;
  ctx: RunnerContext;
  onProgress?: (p: RunnerProgress) => void;
  signal?: AbortSignal;
}

/** What a run cost. Reported so the floor stays visible — it is not small. */
export interface RunnerUsage {
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  /** Usually the bulk of it: the methodology and agent files re-sent every turn. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
  models: string[];
}

export interface RunnerResult {
  ok: boolean;
  /** Whatever the pipeline said last. Rendered verbatim; never parsed for state. */
  finalText?: string;
  error?: string;
  usage?: RunnerUsage;
  /** Tool calls the confinement policy refused. Surfaced: a silently hobbled run looks like a slow one. */
  refusals?: { tool: string; reason: string }[];
}

export interface DesignRunner {
  readonly kind: "stub" | "agent-sdk";
  /**
   * Verify the target repo is val-inited and the design pipeline is registered.
   * Real in every runner, including the stub: a stub against a repo that was never
   * val-inited is still a misconfiguration Studio must not hide.
   */
  preflight(targetRepo: string): Promise<PreflightResult>;
  /** Gate 0 → Gate 4. Drives `/design <brief>`. */
  design(inv: RunnerInvocation): Promise<RunnerResult>;
  /** Gate 4b → Gate 7. Drives `/design build <run-dir>`. The pipeline owns the seal. */
  build(inv: RunnerInvocation): Promise<RunnerResult>;
}

/** The five specialist agents /design delegates to. All five, or the run is refused. */
export const REQUIRED_AGENTS = [
  "design-brief-intake",
  "design-concept-architect",
  "design-critic",
  "design-page-builder",
  "design-handoff-verifier",
] as const;

/** The orchestrator itself. */
export const REQUIRED_COMMANDS = ["design"] as const;
