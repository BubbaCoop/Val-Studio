/**
 * Parsing the clarification shape (methodology §3, §8b).
 *
 *   Q: / TRIGGER: / NEEDED-FOR: / CHECKED: / COST-OF-GUESSING: / ROUTE: / ACCEPTABLE-ANSWER:
 *
 * Studio parses these ONLY to lay them out as separate fields — every value is kept
 * verbatim, and `raw` always carries the unparsed block so the UI can fall back to
 * rendering exactly what the pipeline wrote. Nothing here paraphrases or normalises.
 *
 * A blocked brief and a refused feedback finding use this same parser, because they
 * arrive in the same shape. ROUTE: is what distinguishes a refusal, and is the only
 * part that tells the designer how to make the ask legal.
 */
import type { ClarificationQuestion, ClarificationRound } from "@valiify/studio-shared";
import { section } from "./tables.ts";

const KEYS = [
  ["Q", "question"],
  ["TRIGGER", "trigger"],
  ["NEEDED-FOR", "neededFor"],
  ["CHECKED", "checked"],
  ["COST-OF-GUESSING", "costOfGuessing"],
  ["ROUTE", "route"],
  ["ACCEPTABLE-ANSWER", "acceptableAnswer"],
] as const;

const KEY_RE = new RegExp(`^\\s*(${KEYS.map(([k]) => k).join("|")})\\s*:\\s*(.*)$`);

/**
 * A line that ends a question, whatever follows it.
 *
 * Real intake output separates questions with a horizontal rule and titles them with a
 * bold heading (`**Q2: Upload progress state is unspecified**`) rather than a markdown
 * `#` heading. Neither is a key line, so without this the LAST field of each question —
 * usually ACCEPTABLE-ANSWER — swallowed the rule and the next question's title. The
 * tracked fixture fences its blocks, which is why this never showed there.
 */
const BOUNDARY_RE = /^\s*(?:-{3,}|\*{3,}|_{3,}|\*\*Q\d+\b|#{1,6}\s)/;

/**
 * Parse one clarification block. Continuation lines belong to the key above them,
 * which is how the real fixtures wrap a long Q or COST-OF-GUESSING across lines.
 */
export function parseClarificationBlock(raw: string, blocking: boolean): ClarificationQuestion | null {
  const out: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = KEY_RE.exec(line);
    if (m) {
      const key = KEYS.find(([k]) => k === m[1])![1];
      current = key;
      out[key] = [m[2]];
      continue;
    }
    // A separator or the next question's title ends the current field. Continuation
    // lines belong to the key above them only until the question itself ends.
    if (BOUNDARY_RE.test(line)) {
      current = null;
      continue;
    }
    if (current && line.trim()) out[current].push(line.trim());
  }
  if (!out.question) return null;
  const join = (k: string) => (out[k] ? out[k].join(" ").trim() || undefined : undefined);
  return {
    question: join("question")!,
    trigger: join("trigger"),
    neededFor: join("neededFor"),
    checked: join("checked"),
    costOfGuessing: join("costOfGuessing"),
    route: join("route"),
    acceptableAnswer: join("acceptableAnswer"),
    blocking,
    raw: raw.trim(),
  };
}

/** Every fenced block in a body, which is how 01-brief.md carries its questions. */
function fencedBlocks(body: string): string[] {
  const out: string[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(m[1]);
  return out;
}

/**
 * Unfenced fallback: a run of lines starting at a `Q:` and ending before the next
 * one. Some stages emit the shape without a fence; the shape is what matters.
 */
function looseBlocks(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let buf: string[] | null = null;
  for (const line of lines) {
    if (/^\s*Q\s*:/.test(line)) {
      if (buf) out.push(buf.join("\n"));
      buf = [line];
      continue;
    }
    if (buf) {
      // Close the block at a separator or the next question's title, so the trailing
      // field does not absorb them.
      if (BOUNDARY_RE.test(line)) {
        out.push(buf.join("\n"));
        buf = null;
        continue;
      }
      buf.push(line);
    }
  }
  if (buf) out.push(buf.join("\n"));
  return out;
}

function blocksIn(body: string): string[] {
  const fenced = fencedBlocks(body).filter((b) => /^\s*Q\s*:/m.test(b));
  return fenced.length ? fenced : looseBlocks(body);
}

/**
 * Parse a document's `## Open questions` section into a round.
 *
 * The section is split into `### BLOCKING` and `### NON-BLOCKING`. Every
 * stop-trigger question is blocking; the single non-blocking class is missing
 * non-legal copy, which carries its proposed default.
 */
export function parseOpenQuestions(
  body: string,
  meta: { gate: number | string; origin: ClarificationRound["origin"]; source: string },
): ClarificationRound | null {
  const open = section(body, "Open questions");
  if (!open) return null;

  const blockingBody = section(open, "BLOCKING");
  const nonBlockingBody = section(open, "NON-BLOCKING");

  const questions: ClarificationQuestion[] = [];
  // When the document does not split the section, treat everything as blocking:
  // under-reporting a blocking question is the dangerous direction.
  const blockingSource = blockingBody ?? (nonBlockingBody ? "" : open);
  for (const raw of blocksIn(blockingSource)) {
    const q = parseClarificationBlock(raw, true);
    if (q) questions.push(q);
  }
  for (const raw of blocksIn(nonBlockingBody ?? "")) {
    const q = parseClarificationBlock(raw, false);
    if (q) questions.push(q);
  }
  questions.forEach((q, i) => (q.id ??= `Q${i + 1}`));

  if (!questions.length && !nonBlockingBody) return null;
  return {
    gate: meta.gate,
    origin: meta.origin,
    source: meta.source,
    questions,
    nonBlockingNote: nonBlockingBody?.trim() || undefined,
  };
}

/** Parse a free-form agent message (a refusal relayed at Gate 4a) into the same shape. */
export function parseClarifications(
  body: string,
  meta: { gate: number | string; origin: ClarificationRound["origin"]; source: string },
): ClarificationRound | null {
  const questions = blocksIn(body)
    .map((raw) => parseClarificationBlock(raw, true))
    .filter((q): q is ClarificationQuestion => q !== null);
  if (!questions.length) return null;
  questions.forEach((q, i) => (q.id ??= `Q${i + 1}`));
  return { gate: meta.gate, origin: meta.origin, source: meta.source, questions };
}
