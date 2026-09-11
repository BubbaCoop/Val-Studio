/**
 * The run model.
 *
 * THE RUN DIRECTORY IS THE SOURCE OF TRUTH — not the agent stream. Every field
 * below is derived from files on disk and from manifest.json. A run driven from
 * the CLI is therefore exactly as observable in Studio as one driven from Studio;
 * agent stream events contribute token-level progress only and never decide what
 * stage a run is in.
 */
import type { Manifest, ManifestLoops, RunStatus, GateRecord } from "./manifest.ts";
import type { ConceptVersion, CopyRow, ConceptDoc } from "./concept.ts";
import type { ClarificationRound } from "./clarification.ts";
import type { FeedbackRound } from "./feedback.ts";
import type { DesignContract } from "./contract.ts";

/**
 * Where a run stands, derived from file presence + manifest. Ordered: each stage
 * implies every earlier one. This is what the SSE channel reports transitions of.
 */
export type RunStage =
  | "setup"           // 00-input/ exists, no brief yet
  | "intake"          // 01-brief.md written
  | "blocked-brief"   // Gate 1 raised BLOCKING questions — awaiting the requester
  | "concept"         // 02-concept/concept.v<n>.html exists
  | "critique"        // 03-critique-<n>.md exists
  | "awaiting-approval" // Gate 4 — the human gate
  | "approved"        // 04-approval.md sealed by /design build
  | "build"           // 05-package/ appearing
  | "verified"        // 06-verify-<n>.md reports VERIFY: PASS
  | "signed-off"      // 07-writeup.md written, manifest status signed-off
  | "needs-human-review";

export const RUN_STAGE_ORDER: RunStage[] = [
  "setup",
  "intake",
  "blocked-brief",
  "concept",
  "critique",
  "awaiting-approval",
  "approved",
  "build",
  "verified",
  "signed-off",
];

/** The critique verdict line: `CRITIQUE: FAIL | FINDINGS: 3 | BLOCKING: 2`. */
export interface CritiqueSummary {
  loop: number;
  fileName: string;
  verdict: "PASS" | "FAIL" | (string & {});
  findings: number;
  blocking: number;
  /** The critic's rows — same columns as human feedback, ids F1, F2 … */
  rows: { id: string; block: string; severity: string; rule: string; finding: string; fix: string }[];
}

/** `06-verify-<n>.md`'s verdict. */
export interface VerifySummary {
  loop: number;
  fileName: string;
  verdict: "PASS" | "FAIL" | (string & {});
}

/**
 * The critic loop counter shown beside its cap. Studio SURFACES the cap and never
 * raises it. Feedback rounds are counted separately and are NEVER presented as capped.
 */
export interface LoopState {
  critic: number;
  criticCap: number;
  verify: number;
  verifyCap: number;
  /** Uncapped by design: a reviewer iterating is the product working. */
  feedback: number;
}

/** Whether this run's files are committed. Studio never commits on its own. */
export interface GitState {
  /** False when the target repo is not a git work tree. */
  isRepo: boolean;
  branch?: string;
  /** Paths inside the run dir with uncommitted changes (porcelain, run-relative). */
  dirtyPaths: string[];
  hasUncommittedChanges: boolean;
  /** Short sha of the last commit touching this run dir, when there is one. */
  lastCommit?: { sha: string; subject: string; at: string };
  /**
   * True only at `signed-off`, where the run dir holds the sha256-sealed approval
   * and the verified package. Never offered at an intermediate gate.
   */
  commitOffered: boolean;
  /** Present when commitOffered is false and the run is dirty — why it is withheld. */
  commitWithheldReason?: string;
}

/** A row in the run list. Cheap: manifest + a directory listing, no file parsing. */
export interface RunSummary {
  /**
   * The run DIRECTORY name. This is the addressable identity: it is what
   * `/design build <run-dir>` takes and what the API resolves. It is deliberately
   * not manifest.runId — real repos contain several directories whose manifests
   * carry the same runId (a re-dispatch, a model comparison), and keying on that
   * would make one run open another.
   */
  runId: string;
  /** manifest.runId, when it differs from the directory name. Shown, never addressed. */
  manifestRunId?: string;
  /** Absolute path. */
  path: string;
  /** Path relative to the target repo root — what /design build is invoked with. */
  relPath: string;
  surface?: string;
  status: RunStatus;
  stage: RunStage;
  loops: LoopState;
  conceptVersions: number;
  hasApproval: boolean;
  hasPackage: boolean;
  updatedAt: string;
  /** True when this run's manifest is absent — a run dir the CLI has only just created. */
  manifestMissing: boolean;
}

/** Everything a screen needs about one run. */
export interface RunDetail extends RunSummary {
  manifest: Manifest | null;
  rawLoops: ManifestLoops;
  gates: GateRecord[];
  brief: { path: string; text: string } | null;
  /** Files copied into 00-input/, in name order. */
  inputs: string[];
  answers: { round: number; fileName: string; text: string }[];
  /**
   * Blocked questions parsed out of 01-brief.md § Open questions, or out of a
   * refused feedback round. Rendered verbatim by the same component.
   */
  clarifications: ClarificationRound[];
  concepts: ConceptVersion[];
  /** The parsed latest concept — the one the overlay renders against. */
  latestConcept: ConceptDoc | null;
  /** concept.md's copy table. The DRAFT rows are what the human gate must approve. */
  copy: CopyRow[];
  critiques: CritiqueSummary[];
  verifications: VerifySummary[];
  feedbackRounds: FeedbackRound[];
  approval: { path: string; text: string; sha256?: string; concept?: string } | null;
  /** True once the sealed hash no longer matches the concept on disk — approval void. */
  approvalHashValid: boolean | null;
  contract: DesignContract | null;
  packageFiles: string[];
  writeup: string | null;
  git: GitState;
}
