/**
 * Human feedback rounds — `00-input/feedback-<n>.md` (methodology §8b).
 *
 * The reviewer uses the SAME table the critic uses, so one rework path serves
 * both. Ids are H1, H2 … (the critic's are F1, F2 …). Every field below is
 * constrained by tools/design/feedback-check.mjs, which Studio runs against every
 * file it writes before offering to send the round.
 */

export type FindingSeverity = "blocking" | "advisory";

/** One row of `| id | block | severity | rule | finding | fix |`. */
export interface FeedbackFinding {
  /** `^H\d+$`, unique within the round. */
  id: string;
  /** A data-block id or a copy id from the PINNED concept, or `-` for the whole page. */
  block: string;
  severity: FindingSeverity;
  /** May be empty — a designer is not expected to cite a methodology §. */
  rule: string;
  /** What is wrong. */
  finding: string;
  /** What to do. Must be non-empty: the architect acts on this column. */
  fix: string;
}

export interface FeedbackRound {
  /** The `n` in feedback-<n>.md. */
  round: number;
  /**
   * The `Concept: concept.v<n>.html` line. REQUIRED, and written from the concept
   * that was actually rendered — never from "the latest". Block ids are stable
   * across versions, so an unpinned round collected on v2 would apply cleanly to
   * v3 with nothing to show it had happened.
   */
  concept: string;
  findings: FeedbackFinding[];
  /** Free prose the reviewer added below the table, preserved verbatim. */
  note?: string;
  path?: string;
}

/** One entry of feedback-check.mjs's `findings[]` — its own diagnostics, not the round's. */
export interface FeedbackCheckDiagnostic {
  /** file | version | table | ids | targets | severity | fix | findings */
  check: string;
  severity: "fail" | "warn";
  message: string;
  detail?: string;
}

/**
 * The report `feedback-check.mjs --out json` writes to `<run-dir>/feedback-check.json`.
 *
 * Studio surfaces `verdict: "FAIL"` in the UI rather than sending a round the
 * pipeline would reject. A `targets` failure means the designer is looking at a
 * stale preview: the correct response is to RE-RENDER the current concept and ask
 * them to re-confirm, never to guess which block they meant.
 */
export interface FeedbackCheckReport {
  tool: "feedback-check";
  runDir: string;
  feedback: string;
  concept: string;
  pinnedConcept: string | null;
  latestConcept: string | null;
  alreadyApplied: boolean;
  round: number | null;
  verdict: "PASS" | "FAIL";
  counts: { findings: number; blocking: number; advisory: number };
  rows: FeedbackFinding[];
  findings: FeedbackCheckDiagnostic[];
  written?: string;
  notWritten?: string;
}

/** What Studio hands back when a round is validated. */
export interface FeedbackValidation {
  report: FeedbackCheckReport | null;
  /** Raw stdout, always kept: the tool's text output is the fallback when no JSON lands. */
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * True when the only thing wrong is the pin — the designer reviewed a version
   * that has since been superseded. The UI must re-render the current concept and
   * ask them to re-confirm, not remap their findings.
   */
  staleConceptPin: boolean;
}
