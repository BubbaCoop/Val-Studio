/**
 * Writing `00-input/feedback-<n>.md` — the human feedback round (§8b).
 *
 * The format is the pipeline's, not ours. The reviewer uses the SAME table the
 * critic uses so one rework path serves both; ids are H1, H2 … because the ledger
 * records who asked.
 *
 * The `Concept:` pin is the load-bearing line. It is written from the concept the
 * designer was ACTUALLY LOOKING AT — never from "the latest". Block ids are stable
 * across versions, so an unpinned round collected on v2 would apply cleanly to v3
 * with nothing to show it had happened. That is why this function refuses to
 * default the pin.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FeedbackFinding, FeedbackRound } from "@valiify/studio-shared";
import { PATTERNS, RUN_FILES, numbered } from "../run/paths.ts";

export class FeedbackWriteError extends Error {}

/**
 * A cell must survive `feedback-check.mjs`, which splits rows on a bare `|`. A pipe
 * typed by a designer would silently shift every later column, so it is written as
 * an entity: the table still renders a pipe, and the validator still sees one cell.
 */
function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "&#124;").trim();
}

export function renderFeedback(round: FeedbackRound): string {
  const lines = [
    `# Feedback ${round.round}`,
    "",
    // Required, and checked for currency by feedback-check.
    `Concept: ${round.concept}`,
    "",
    "| id | block | severity | rule | finding | fix |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const f of round.findings) {
    lines.push(
      `| ${cell(f.id)} | ${cell(f.block)} | ${cell(f.severity)} | ${cell(f.rule ?? "")} | ${cell(f.finding ?? "")} | ${cell(f.fix)} |`,
    );
  }
  if (round.note?.trim()) lines.push("", round.note.trim());
  return lines.join("\n") + "\n";
}

/** The next round number — `loops.feedback` + 1 in practice, read from disk. */
export async function nextRound(runDir: string): Promise<number> {
  const existing = await numbered(join(runDir, RUN_FILES.inputDir), PATTERNS.feedback);
  return (existing.at(-1)?.n ?? 0) + 1;
}

export interface PreparedRound {
  round: FeedbackRound;
  markdown: string;
  /** Run-relative. */
  relPath: string;
  absPath: string;
}

export async function prepareRound(
  runDir: string,
  input: { concept: string; findings: FeedbackFinding[]; note?: string },
): Promise<PreparedRound> {
  const concept = basename(input.concept || "");
  if (!concept) {
    throw new FeedbackWriteError(
      "A feedback round must pin the concept version it was collected against. " +
        "Write it from the concept that was rendered, never from the latest one.",
    );
  }
  if (!/^concept\.v\d+\.html$/.test(concept)) {
    throw new FeedbackWriteError(`"${concept}" is not a concept.v<n>.html file name.`);
  }
  if (!existsSync(join(runDir, RUN_FILES.conceptDir, concept))) {
    throw new FeedbackWriteError(`The pinned concept ${concept} is not in 02-concept/.`);
  }
  if (!input.findings.length) {
    throw new FeedbackWriteError(
      "A round with no findings would burn a concept version for no change.",
    );
  }

  const round = await nextRound(runDir);
  const withIds: FeedbackFinding[] = input.findings.map((f, i) => ({
    ...f,
    // H for human; the critic uses F. The ledger records which of the two asked.
    id: /^H\d+$/.test(f.id ?? "") ? f.id : `H${i + 1}`,
  }));
  const model: FeedbackRound = { round, concept, findings: withIds, note: input.note };
  const relPath = `${RUN_FILES.inputDir}/feedback-${round}.md`;
  return { round: model, markdown: renderFeedback(model), relPath, absPath: join(runDir, relPath) };
}

export async function writeRound(prepared: PreparedRound): Promise<void> {
  await mkdir(join(prepared.absPath, ".."), { recursive: true });
  await writeFile(prepared.absPath, prepared.markdown, "utf8");
}
