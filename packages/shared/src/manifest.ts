/**
 * `manifest.json` — the run record the orchestrator maintains.
 *
 * Typed against the real fixtures in the target repo (a signed-off run and a
 * blocked-brief run), not against an idealised shape. Notably:
 *   - `gates[].gate` is `4b` (a string) in a real run, and `1` (a number) in others.
 *   - `loops` is missing `feedback` entirely in a run that never had a round.
 *   - `model` is recorded per gate as well as at the top level, deliberately.
 *
 * Studio only ever READS this file. The orchestrator writes it.
 */

/** Open union: the pipeline may add a status Studio has not seen. */
export type RunStatus =
  | "running"
  | "awaiting-requester"
  | "awaiting-approval"
  | "needs-human-review"
  | "signed-off"
  | (string & {});

export type GateStatus = "pass" | "fail" | "blocked" | (string & {});

/** A question recorded on a gate record. The full six-line shape lives in the md file. */
export interface ManifestQuestion {
  id: string;
  blocking?: boolean;
  trigger?: string;
  summary?: string;
  proposedDefault?: string;
}

export interface GateRecord {
  /** `1`..`7`, or `"4b"` for the approval seal. */
  gate: number | string;
  agent: string;
  status: GateStatus;
  at: string;
  /** Read at the time the gate returned — a gate whose model differs from the run's is a finding. */
  model?: string;
  loop?: number;
  concept?: string;
  notes?: string;
  attempts?: number;
  questions?: ManifestQuestion[];
  answered?: string;
  unsureForLater?: string[];
  findings?: { total?: number; blocking?: number; advisory?: number };
  [k: string]: unknown;
}

export interface ManifestLoops {
  /** Capped at 3 by the orchestrator. Studio SURFACES the cap and never raises it. */
  critic?: number;
  /** Capped at 3 by the orchestrator. */
  verify?: number;
  /** Uncapped, and deliberately separate from `critic`. Absent in runs with no round. */
  feedback?: number;
}

export interface ManifestApproval {
  /** Run-relative path, e.g. `02-concept/concept.v2.html`. */
  concept: string;
  /** Computed by `/design build`. Studio never computes this. */
  sha256: string;
  at: string;
}

export interface Manifest {
  kind: string;
  runId: string;
  library?: string;
  package?: string;
  surface?: string;
  methodology?: string;
  output?: string;
  model?: string;
  gates?: GateRecord[];
  loops?: ManifestLoops;
  approval?: ManifestApproval | null;
  status?: RunStatus;
  notes?: string;
  [k: string]: unknown;
}

/** The orchestrator's hard cap on the critic loop (design.template.md, Gate 3). */
export const CRITIC_LOOP_CAP = 3;
/** The orchestrator's hard cap on the verification loop (Gate 6). */
export const VERIFY_LOOP_CAP = 3;
