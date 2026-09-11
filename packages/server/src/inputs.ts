/**
 * Authoring the two files Studio is allowed to write.
 *
 * Studio authors briefs and critique findings. That is the whole list. It does not
 * write 01-brief.md (design-brief-intake's output), does not write a concept, does
 * not write 04-approval.md, and does not write manifest.json — Gate 0 does that when
 * `/design <brief-path>` runs.
 *
 * So a new run starts by writing the REQUESTER'S brief to val/briefs/ and then
 * driving `/design` at it. The run directory is created by the pipeline, on its own
 * Gate 0 convention, and Studio learns about it from the runs-root watcher.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BriefSchemaField } from "@valiify/studio-shared";
import { PATTERNS, RUN_FILES, numbered } from "./run/paths.ts";

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** Gate 0's directory convention, from templates/commands/design.template.md. */
export function expectedRunId(slug: string, now = new Date()): string {
  return `${now.toISOString().slice(0, 10)}-design-${slug}`;
}

/**
 * Render the authored brief.
 *
 * Headings are emitted in `design.surfaces[<id>].briefSchema` ORDER, because that
 * order is part of the contract: intake checks 01-brief.md against the same list.
 * A required heading the requester left empty is still emitted, empty — a
 * `brief-missing-field` stop belongs to intake, and silently dropping the heading
 * would hide the gap rather than raise it.
 */
export function renderBrief(
  slug: string,
  surfaceId: string,
  methodologyPath: string,
  schema: BriefSchemaField[],
  sections: { heading: string; body: string }[],
): string {
  const byHeading = new Map(sections.map((s) => [s.heading.trim().toLowerCase(), s.body]));
  const lines = [`# Brief — ${slug}`, `## Surface ${surfaceId} · methodology ${methodologyPath}`, ""];
  for (const field of schema) {
    lines.push(`## ${field.heading}`, "");
    const body = (byHeading.get(field.heading.trim().toLowerCase()) ?? "").trim();
    lines.push(body || (field.required ? "_(not supplied)_" : ""), "");
  }
  // Anything the requester typed under a heading the schema does not define is kept
  // rather than dropped: intake is entitled to see everything they wrote.
  const known = new Set(schema.map((f) => f.heading.trim().toLowerCase()));
  for (const s of sections) {
    if (known.has(s.heading.trim().toLowerCase()) || !s.body.trim()) continue;
    lines.push(`## ${s.heading}`, "", s.body.trim(), "");
  }
  return lines.join("\n");
}

export async function writeBrief(
  targetRepo: string,
  slug: string,
  markdown: string,
): Promise<{ absPath: string; relPath: string }> {
  const relPath = `val/briefs/brief-${slug}.md`;
  const absPath = join(targetRepo, relPath);
  await mkdir(join(absPath, ".."), { recursive: true });
  await writeFile(absPath, markdown, "utf8");
  return { absPath, relPath };
}

/**
 * Answers to a BRIEF: BLOCKED round, saved VERBATIM to 00-input/answers-<n>.md —
 * which is what the pipeline expects and what intake re-reads.
 *
 * "Verbatim" is the requirement, not a nicety: the requester's exact words are the
 * record of what was decided. Studio adds the question headings around them so the
 * answers are attributable, and never rewrites the answers themselves.
 */
export async function writeAnswers(
  runDir: string,
  answers: { questionId: string; text: string }[],
  note?: string,
): Promise<{ round: number; relPath: string; absPath: string }> {
  const inputDir = join(runDir, RUN_FILES.inputDir);
  const existing = await numbered(inputDir, PATTERNS.answers);
  const round = (existing.at(-1)?.n ?? 0) + 1;
  const lines = [`# Answers ${round} — requester, ${new Date().toISOString().slice(0, 10)}`, ""];
  if (note?.trim()) lines.push(note.trim(), "");
  for (const a of answers) {
    lines.push(`## ${a.questionId}`, "", "Verbatim answer from the requester:", "");
    for (const line of a.text.replace(/\r\n/g, "\n").split("\n")) lines.push(`> ${line}`);
    lines.push("");
  }
  const relPath = `${RUN_FILES.inputDir}/answers-${round}.md`;
  const absPath = join(runDir, relPath);
  await mkdir(inputDir, { recursive: true });
  await writeFile(absPath, lines.join("\n"), "utf8");
  return { round, relPath, absPath };
}
