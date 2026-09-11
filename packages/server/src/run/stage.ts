/**
 * Deriving a run's stage FROM THE RUN DIRECTORY.
 *
 * This function is the reason a CLI-driven run is as observable in Studio as one
 * Studio started: it reads files and manifest.json, never an agent stream. When the
 * manifest and the files disagree, the files win for "has this artefact appeared"
 * and the manifest wins for "what is the orchestrator waiting on" — because only the
 * manifest can express awaiting-approval, which no file's presence implies.
 */
import type { Manifest, RunStage } from "@valiify/studio-shared";

export interface StageInputs {
  manifest: Manifest | null;
  hasBrief: boolean;
  /** 01-brief.md carries at least one BLOCKING question. */
  briefBlocked: boolean;
  conceptCount: number;
  critiqueCount: number;
  hasApproval: boolean;
  hasPackage: boolean;
  /** A 06-verify-<n>.md reporting PASS. */
  verifyPassed: boolean;
  hasWriteup: boolean;
}

export interface StageResult {
  stage: RunStage;
  /** The evidence on disk. Reported on every transition so a gate change is never a guess. */
  because: string;
}

export function deriveStage(i: StageInputs): StageResult {
  const status = i.manifest?.status;

  if (status === "needs-human-review") {
    return { stage: "needs-human-review", because: "manifest.status = needs-human-review" };
  }
  if (i.hasWriteup || status === "signed-off") {
    return { stage: "signed-off", because: i.hasWriteup ? "07-writeup.md present" : "manifest.status = signed-off" };
  }
  if (i.verifyPassed) return { stage: "verified", because: "06-verify-<n>.md reports VERIFY: PASS" };
  if (i.hasPackage) return { stage: "build", because: "05-package/ present" };
  if (i.hasApproval) return { stage: "approved", because: "04-approval.md present (sealed by /design build)" };
  if (status === "awaiting-approval") {
    return { stage: "awaiting-approval", because: "manifest.status = awaiting-approval" };
  }
  // A blocked brief is checked before the concept: an intake that stopped has no
  // concept to move on to, and the requester is the one being waited on.
  if (i.briefBlocked || (i.hasBrief && status === "awaiting-requester" && i.conceptCount === 0)) {
    return { stage: "blocked-brief", because: "01-brief.md has BLOCKING open questions" };
  }
  if (i.critiqueCount > 0) return { stage: "critique", because: `03-critique-${i.critiqueCount}.md present` };
  if (i.conceptCount > 0) return { stage: "concept", because: `02-concept/concept.v${i.conceptCount}.html present` };
  if (i.hasBrief) return { stage: "intake", because: "01-brief.md present" };
  return { stage: "setup", because: "run directory created; no 01-brief.md yet" };
}
