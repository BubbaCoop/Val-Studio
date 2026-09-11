/**
 * The run directory's fixed layout, as `/design` creates it.
 *
 * Every path Studio knows about is listed here once, so the watcher, the reader and
 * the artefact classifier cannot drift apart.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunFileEvent } from "@valiify/studio-shared";

export const RUN_FILES = {
  manifest: "manifest.json",
  brief: "01-brief.md",
  approval: "04-approval.md",
  writeup: "07-writeup.md",
  inputDir: "00-input",
  conceptDir: "02-concept",
  packageDir: "05-package",
  conceptMd: "02-concept/concept.md",
  fixLedger: "02-concept/fix-ledger.md",
  contract: "05-package/contract.json",
  feedbackCheck: "feedback-check.json",
  handoffCheck: "handoff-check.json",
} as const;

export const PATTERNS = {
  concept: /^concept\.v(\d+)\.html$/,
  critique: /^03-critique-(\d+)\.md$/,
  verify: /^06-verify-(\d+)\.md$/,
  answers: /^answers-(\d+)\.md$/,
  feedback: /^feedback-(\d+)\.md$/,
} as const;

/** Classify a run-relative path into the artefact class the SSE channel reports. */
export function classify(rel: string): RunFileEvent["artefact"] {
  const p = rel.replace(/\\/g, "/");
  if (p === RUN_FILES.manifest) return "manifest";
  if (p === RUN_FILES.brief) return "brief";
  if (p === RUN_FILES.approval) return "approval";
  if (p === RUN_FILES.writeup) return "writeup";
  if (p === RUN_FILES.conceptMd) return "concept-md";
  if (p === RUN_FILES.fixLedger) return "fix-ledger";
  if (p === RUN_FILES.contract) return "contract";
  if (p === RUN_FILES.feedbackCheck || p === RUN_FILES.handoffCheck) return "check-report";
  if (PATTERNS.critique.test(p)) return "critique";
  if (PATTERNS.verify.test(p)) return "verify";
  if (p.startsWith("02-concept/") && PATTERNS.concept.test(p.slice("02-concept/".length))) return "concept";
  if (p.startsWith("00-input/")) {
    const name = p.slice("00-input/".length);
    if (PATTERNS.answers.test(name)) return "answers";
    if (PATTERNS.feedback.test(name)) return "feedback";
  }
  if (p.startsWith("05-package/")) return "package";
  return undefined;
}

export interface Numbered {
  n: number;
  name: string;
}

/** Every file in `dir` matching `re` (capture 1 = the number), ascending. */
export async function numbered(dir: string, re: RegExp): Promise<Numbered[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const hits: Numbered[] = [];
  for (const name of names) {
    const m = re.exec(name);
    if (m) hits.push({ n: Number(m[1]), name });
  }
  return hits.sort((a, b) => a.n - b.n);
}

/** Recursive file list, run-relative, sorted. Skips nothing: the package dir matters. */
export async function walk(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(root, child)));
    else out.push(child);
  }
  return out.sort();
}
