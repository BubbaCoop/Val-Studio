/**
 * The HTTP surface — the seam a hosted runner replaces.
 *
 * The frontend knows only these shapes. Swapping the local Node service for a
 * hosted one means implementing this surface; no frontend change.
 */
import type { BriefSchemaField, TargetRepoInfo } from "./val-config.ts";
import type { FeedbackFinding, FeedbackValidation } from "./feedback.ts";
import type { RunDetail, RunSummary } from "./run.ts";

/**
 * The startup preflight, run for real against the target repo.
 *
 * With cwd set to the target repo and settingSources ["user","project","local"],
 * supportedAgents() must return all five design-* subagents and supportedCommands()
 * must return `design`. A miss means the target repo was never val-inited, and the
 * pipeline would degrade to general-purpose agents — the precise failure /design
 * refuses to run into. Studio fails loudly rather than starting degraded.
 */
export interface PreflightResult {
  ok: boolean;
  at: string;
  targetRepo: string;
  /** The five the pipeline requires. */
  requiredAgents: string[];
  foundAgents: string[];
  missingAgents: string[];
  requiredCommands: string[];
  foundCommands: string[];
  missingCommands: string[];
  /** The agents' generated header says which library they belong to (Gate 0 check 5). */
  agentLibrary?: string;
  configLibrary?: string;
  libraryMatches?: boolean;
  durationMs: number;
  error?: string;
}

export interface StudioHealth {
  ok: boolean;
  version: string;
  /** The runner actually wired in. `stub` means no real agent run happens. */
  runner: "stub" | "agent-sdk";
  preflight: PreflightResult;
  target: TargetRepoInfo;
}

/** `POST /api/runs` — Gate 0 + Gate 1. Studio authors the brief; the pipeline writes 01-brief.md. */
export interface CreateRunRequest {
  surfaceId: string;
  /** Slug for the run directory: `<yyyy-mm-dd>-design-<slug>`. */
  slug: string;
  /**
   * The authored brief, heading by heading, in `design.surfaces[id].briefSchema`
   * order. Studio writes these to 00-input/ as the requester's brief — it does NOT
   * write 01-brief.md, which is design-brief-intake's output.
   */
  sections: { heading: string; body: string }[];
}

export interface CreateRunResponse {
  /** The run id the orchestrator's Gate 0 convention produces: `<yyyy-mm-dd>-design-<slug>`. */
  runId: string;
  relPath: string;
  /**
   * Where Studio wrote the requester's brief. Studio authors THIS file and nothing
   * else: `/design <brief-path>` is then driven, and Gate 0 creates the run
   * directory and writes manifest.json. Studio does not do Gate 0's work.
   */
  briefPath: string;
  /** The prompt text sent to drive the pipeline. Surfaced so the UI can show it. */
  prompt: string;
  /** Null until Gate 0 has created the directory — the runs watcher fills it in over SSE. */
  run: RunDetail | null;
}

/** `POST /api/runs/:runId/answers` — answers to a BRIEF: BLOCKED round. */
export interface SubmitAnswersRequest {
  /**
   * Saved VERBATIM to 00-input/answers-<n>.md, which is what the pipeline expects.
   * Studio does not rewrite, summarise or normalise the requester's words.
   */
  answers: { questionId: string; text: string }[];
  /** Optional preamble the UI collected; also written verbatim. */
  note?: string;
}

/** `POST /api/runs/:runId/feedback` — a Gate 4a round from the concept composer. */
export interface SubmitFeedbackRequest {
  /**
   * The concept file name the designer was ACTUALLY LOOKING AT, e.g.
   * `concept.v2.html`. Written to the `Concept:` pin line. Never "the latest":
   * an unpinned or mis-pinned round is exactly the failure the pin exists to catch.
   */
  concept: string;
  findings: FeedbackFinding[];
  note?: string;
  /** When true, validate and return the report without keeping the file. */
  dryRun?: boolean;
}

export interface SubmitFeedbackResponse {
  /** The file Studio wrote (or would have written, on a dry run). */
  path: string;
  round: number;
  validation: FeedbackValidation;
  /**
   * False when feedback-check FAILED. Studio does not dispatch a round the
   * pipeline would reject; the UI shows the tool's own failures instead.
   */
  accepted: boolean;
  run: RunDetail;
}

/** `POST /api/runs/:runId/approve` — invokes `/design build <run-dir>`. */
export interface ApproveRequest {
  /**
   * The reviewer's invoking message, recorded verbatim in 04-approval.md by the
   * PIPELINE. Studio never writes that file and never computes the sha256.
   */
  message: string;
}

/** `POST /api/runs/:runId/commit` — the explicit, never-automatic commit. */
export interface CommitRunRequest {
  message?: string;
}

export interface CommitRunResponse {
  committed: boolean;
  sha?: string;
  message?: string;
  /** Set when the run is not at signed-off, or nothing was dirty. */
  refusedReason?: string;
}

/** `GET /api/surfaces/:id/brief-schema` — what the form generator renders. */
export interface BriefSchemaResponse {
  surfaceId: string;
  displayName?: string;
  methodologyPath: string;
  /** In order. Order is part of the contract: 01-brief.md's headings follow it. */
  fields: BriefSchemaField[];
  /** Shown beside the form so the requester knows what will stop the run. */
  stopTriggers: { trigger: string; when: string }[];
}

export interface RunListResponse {
  runs: RunSummary[];
}

export interface ApiError {
  error: string;
  detail?: string;
  /** Set when the failure is the preflight — the UI renders this, loudly. */
  preflight?: PreflightResult;
}
