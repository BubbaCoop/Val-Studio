/**
 * Reading a run directory into the typed model the frontend consumes.
 *
 * The run directory and git are the only state Studio has. Nothing here caches, and
 * nothing here writes — this module is pure read, so it can be called on every file
 * event without a consistency problem.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type {
  ClarificationRound,
  ConceptVersion,
  CopyRow,
  CritiqueSummary,
  DesignContract,
  FeedbackRound,
  LoopState,
  Manifest,
  RunDetail,
  RunSummary,
  VerifySummary,
} from "@valiify/studio-shared";
import { CRITIC_LOOP_CAP, VERIFY_LOOP_CAP } from "@valiify/studio-shared";
import { parseConcept } from "../parse/concept.ts";
import { parseClarifications, parseOpenQuestions } from "../parse/clarification.ts";
import { readTable, section } from "../parse/tables.ts";
import { readGitState } from "../git.ts";
import { deriveStage } from "./stage.ts";
import { PATTERNS, RUN_FILES, numbered, walk } from "./paths.ts";
import { runKey, type RunRoot } from "./roots.ts";

const FINDING_COLUMNS = ["id", "block", "severity", "rule", "finding", "fix"];

/**
 * How long a run may claim to be `running` without touching a file before Studio shows
 * it as stale. Generous on purpose: a concept architect legitimately runs for many
 * minutes, and one real run in the target repo records a stage killed by a watchdog at
 * 600s. Calling a working stage dead is worse than waiting.
 */
export const DEFAULT_STALE_AFTER_MS = 15 * 60_000;

/** Statuses that assert something is happening right now. The rest are legitimate waits. */
const IN_FLIGHT_STATUSES = new Set(["running"]);

/** The most recent mtime anywhere in the run directory, including the directory itself. */
async function lastActivity(runDir: string): Promise<number> {
  let newest = await stat(runDir)
    .then((s) => s.mtimeMs)
    .catch(() => 0);
  for (const rel of await walk(runDir)) {
    const m = await stat(join(runDir, rel))
      .then((s) => s.mtimeMs)
      .catch(() => 0);
    if (m > newest) newest = m;
  }
  return newest;
}

async function readIf(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read JSON, reporting WHY it is absent.
 *
 * A half-written manifest is normal while an agent is mid-write and the next watcher
 * event re-reads it, so a bad parse never throws the whole run away. But "the file is
 * not there" and "the file is there and is corrupt" are different facts, and
 * collapsing them into `null` hid the second one completely.
 */
async function readJson<T>(path: string): Promise<{ value: T | null; missing: boolean; error?: string }> {
  const text = await readIf(path);
  if (text === null) return { value: null, missing: true };
  try {
    return { value: JSON.parse(text) as T, missing: false };
  } catch (err) {
    return { value: null, missing: false, error: `${basename(path)} is not valid JSON: ${(err as Error).message}` };
  }
}

/**
 * The verdict line.
 *
 * The template specifies one spelling — `CRITIQUE: FAIL | FINDINGS: 3 | BLOCKING: 2`
 * — and the runs in the target repo carry two: that one, and a prose
 * `**VERDICT: FAIL** — 1 blocking finding` opener with the machine line further down.
 * Both are accepted, because guessing which one a given stage used would make the
 * reader wrong half the time. The divergence is an upstream defect, not Studio's to
 * normalise away.
 *
 * The counts are read from the STATUS LINE only — the first line that carries the
 * keyword and a `FINDINGS:` count — never from the whole document. A critique that
 * quotes an earlier verdict, or a findings table whose prose says "FINDINGS: 2", would
 * otherwise be scraped as this critique's own count.
 *
 * Exported so the two spellings can be pinned by test against the real files; nothing
 * else calls it.
 */
export function verdictOf(text: string, keyword: string): { verdict: string; findings?: number; blocking?: number } {
  const verdictRe = new RegExp(`\\*{0,2}(?:${keyword}|VERDICT)\\*{0,2}\\s*:\\s*\\*{0,2}(PASS|FAIL|OK|BLOCKED)`, "i");
  let verdict: string | undefined;
  let counts: { findings?: number; blocking?: number } | undefined;

  for (const line of text.split(/\r?\n/)) {
    const m = verdictRe.exec(line);
    if (!m) continue;
    verdict ??= m[1].toUpperCase();
    const findings = /\bFINDINGS\s*:\s*(\d+)/i.exec(line);
    if (!findings) continue;
    const blocking = /\bBLOCKING\s*:\s*(\d+)/i.exec(line);
    counts = { findings: Number(findings[1]), blocking: blocking ? Number(blocking[1]) : undefined };
    break;
  }
  return { verdict: verdict ?? "UNKNOWN", ...(counts ?? {}) };
}

function loopState(m: Manifest | null): LoopState {
  const l = m?.loops ?? {};
  return {
    critic: l.critic ?? 0,
    criticCap: CRITIC_LOOP_CAP,
    verify: l.verify ?? 0,
    verifyCap: VERIFY_LOOP_CAP,
    // Absent in every run whose reviewer never sent a round — and uncapped by design.
    feedback: l.feedback ?? 0,
  };
}

async function conceptVersions(runDir: string): Promise<ConceptVersion[]> {
  const dir = join(runDir, RUN_FILES.conceptDir);
  const hits = await numbered(dir, PATTERNS.concept);
  return Promise.all(
    hits.map(async (h) => ({
      version: h.n,
      fileName: h.name,
      path: `${RUN_FILES.conceptDir}/${h.name}`,
      mtime: await stat(join(dir, h.name))
        .then((s) => s.mtime.toISOString())
        .catch(() => new Date(0).toISOString()),
    })),
  );
}

/**
 * A cheap summary: manifest plus a directory listing, with no markdown parsed.
 *
 * `root` says which runs root the directory came from; omit it and the run is treated
 * as a live, writable one, which is what a direct call with a path means.
 */
export async function readRunSummary(
  repo: string,
  runDir: string,
  root?: RunRoot,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): Promise<RunSummary> {
  const dirName = basename(runDir);
  const m = await readJson<Manifest>(join(runDir, RUN_FILES.manifest));
  const manifest = m.value;
  const concepts = await conceptVersions(runDir);
  const critiques = await numbered(runDir, PATTERNS.critique);
  const verifies = await numbered(runDir, PATTERNS.verify);
  const brief = await readIf(join(runDir, RUN_FILES.brief));

  // A run directory that cannot be listed is a real failure, not an empty run.
  let readError: string | undefined;
  try {
    await readdir(runDir);
  } catch (err) {
    readError = `cannot read the run directory: ${(err as Error).message}`;
  }

  let verifyPassed = false;
  for (const v of verifies) {
    const text = await readIf(join(runDir, v.name));
    if (text && verdictOf(text, "VERIFY").verdict === "PASS") verifyPassed = true;
  }

  const briefBlocked = !!brief && briefIsBlocked(brief);
  const { stage } = deriveStage({
    manifest,
    hasBrief: !!brief,
    briefBlocked,
    conceptCount: concepts.length,
    critiqueCount: critiques.length,
    hasApproval: existsSync(join(runDir, RUN_FILES.approval)),
    hasPackage: existsSync(join(runDir, RUN_FILES.packageDir)),
    verifyPassed,
    hasWriteup: existsSync(join(runDir, RUN_FILES.writeup)),
  });

  const activityMs = await lastActivity(runDir);
  const status = manifest?.status ?? "running";
  // Display-only. Nothing is written to the run directory to record this.
  const stale = IN_FLIGHT_STATUSES.has(String(status)) && Date.now() - activityMs > staleAfterMs;

  return {
    // The directory is the identity — see RunSummary.runId. A fixture's is namespaced
    // so it can never be confused with a live run of the same name.
    runId: root ? runKey(root, dirName) : dirName,
    manifestRunId: manifest?.runId && manifest.runId !== dirName ? manifest.runId : undefined,
    path: runDir,
    relPath: relative(repo, runDir),
    surface: manifest?.surface,
    status,
    stage,
    loops: loopState(manifest),
    conceptVersions: concepts.length,
    hasApproval: existsSync(join(runDir, RUN_FILES.approval)),
    hasPackage: existsSync(join(runDir, RUN_FILES.packageDir)),
    updatedAt: new Date(activityMs || 0).toISOString(),
    lastActivityAt: new Date(activityMs || 0).toISOString(),
    stale,
    staleAfterMs,
    manifestMissing: m.missing,
    manifestError: m.error,
    readError,
    root: root?.id ?? "runs",
    readOnly: root?.readOnly ?? false,
  };
}

/** Does 01-brief.md carry a BLOCKING question? Parsed, not guessed from the manifest. */
function briefIsBlocked(brief: string): boolean {
  const round = parseOpenQuestions(brief, { gate: 1, origin: "brief", source: RUN_FILES.brief });
  return !!round?.questions.some((q) => q.blocking);
}

export async function readRunDetail(
  repo: string,
  runDir: string,
  root?: RunRoot,
  staleAfterMs?: number,
): Promise<RunDetail> {
  const summary = await readRunSummary(repo, runDir, root, staleAfterMs);
  const manifest = (await readJson<Manifest>(join(runDir, RUN_FILES.manifest))).value;

  const briefText = await readIf(join(runDir, RUN_FILES.brief));
  const clarifications = await readClarifications(runDir, briefText);

  const inputDir = join(runDir, RUN_FILES.inputDir);
  const inputs = await walk(inputDir);
  const answers = await Promise.all(
    (await numbered(inputDir, PATTERNS.answers)).map(async (a) => ({
      round: a.n,
      fileName: a.name,
      text: (await readIf(join(inputDir, a.name))) ?? "",
    })),
  );

  const feedbackRounds: FeedbackRound[] = await Promise.all(
    (await numbered(inputDir, PATTERNS.feedback)).map(async (f) => {
      const text = (await readIf(join(inputDir, f.name))) ?? "";
      const pin = /^[ \t]*concept[ \t]*:[ \t]*(\S+)[ \t]*$/im.exec(text);
      return {
        round: f.n,
        concept: pin ? basename(pin[1]) : "",
        findings: readTable(text, FINDING_COLUMNS) as unknown as FeedbackRound["findings"],
        path: `${RUN_FILES.inputDir}/${f.name}`,
      };
    }),
  );

  const concepts = await conceptVersions(runDir);
  const latest = concepts.at(-1);
  let latestConcept = null;
  if (latest) {
    const html = await readIf(join(runDir, latest.path));
    if (html) latestConcept = parseConcept(html, latest.version, latest.fileName);
  }

  const conceptMd = await readIf(join(runDir, RUN_FILES.conceptMd));
  const copy: CopyRow[] = conceptMd
    ? (readTable(section(conceptMd, "Copy table") ?? conceptMd, ["id", "role", "text", "source", "§8 rule"]) as unknown as CopyRow[])
    : [];

  const critiques: CritiqueSummary[] = await Promise.all(
    (await numbered(runDir, PATTERNS.critique)).map(async (c) => {
      const text = (await readIf(join(runDir, c.name))) ?? "";
      const v = verdictOf(text, "CRITIQUE");
      const rows = readTable(text, FINDING_COLUMNS) as unknown as CritiqueSummary["rows"];
      return {
        loop: c.n,
        fileName: c.name,
        verdict: v.verdict,
        findings: v.findings ?? rows.length,
        blocking: v.blocking ?? rows.filter((r) => r.severity?.toLowerCase() === "blocking").length,
        rows,
      };
    }),
  );

  const verifications: VerifySummary[] = await Promise.all(
    (await numbered(runDir, PATTERNS.verify)).map(async (v) => {
      const text = (await readIf(join(runDir, v.name))) ?? "";
      return { loop: v.n, fileName: v.name, verdict: verdictOf(text, "VERIFY").verdict };
    }),
  );

  const approvalText = await readIf(join(runDir, RUN_FILES.approval));
  let approval = null;
  let approvalHashValid: boolean | null = null;
  if (approvalText) {
    const sha = /\b([a-f0-9]{64})\b/i.exec(approvalText)?.[1];
    const conceptName = /concept\.v\d+\.html/.exec(approvalText)?.[0] ?? manifest?.approval?.concept;
    approval = {
      path: RUN_FILES.approval,
      text: approvalText,
      sha256: sha ?? manifest?.approval?.sha256,
      concept: conceptName ? basename(conceptName) : undefined,
    };
    // Studio never COMPUTES the seal — /design build does. It re-checks it, because
    // a concept edited after approval voids that approval and the reviewer must know.
    if (sha && approval.concept) {
      const html = await readFile(join(runDir, RUN_FILES.conceptDir, approval.concept)).catch(() => null);
      approvalHashValid = html ? createHash("sha256").update(html).digest("hex") === sha.toLowerCase() : null;
    }
  }

  const contract = (await readJson<DesignContract>(join(runDir, RUN_FILES.contract))).value;
  const packageFiles = await walk(join(runDir, RUN_FILES.packageDir));
  const writeup = await readIf(join(runDir, RUN_FILES.writeup));
  const git = await readGitState(repo, runDir, summary.stage);

  return {
    ...summary,
    manifest,
    rawLoops: manifest?.loops ?? {},
    gates: manifest?.gates ?? [],
    brief: briefText ? { path: RUN_FILES.brief, text: briefText } : null,
    inputs,
    answers,
    clarifications,
    concepts,
    latestConcept,
    copy,
    critiques,
    verifications,
    feedbackRounds,
    approval,
    approvalHashValid,
    contract,
    packageFiles,
    writeup,
    git,
  };
}

/**
 * Every run directory under every configured root, newest first.
 *
 * A root that is not on disk is reported rather than treated as empty: "no runs yet"
 * and "the configured runOutputDir does not exist" are different problems, and only
 * one of them is the user's to fix.
 */
export async function listRuns(
  repo: string,
  roots: RunRoot[],
  staleAfterMs?: number,
): Promise<{ runs: RunSummary[]; errors: string[] }> {
  const runs: RunSummary[] = [];
  const errors: string[] = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch (err) {
      // The fixtures root is optional by convention; the runs root is not.
      if (root.id === "runs") {
        errors.push(`Cannot read ${root.relDir}/ (paths.runOutputDir): ${(err as Error).message}`);
      }
      continue;
    }
    runs.push(
      ...(await Promise.all(
        entries
          .filter((e) => e.isDirectory())
          .map((e) => readRunSummary(repo, join(root.dir, e.name), root, staleAfterMs)),
      )),
    );
  }
  return { runs: runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), errors };
}

/**
 * Every clarification round the run directory carries, in gate order.
 *
 * The methodology gives a blocked brief, a blocked concept and a refused feedback
 * finding the SAME six-line shape (§3, §8b), so all three are parsed by the same
 * parsers and rendered by the same component. Reading only 01-brief.md — which is what
 * this did — made a Gate 2 stop and a Gate 4a refusal invisible in Studio.
 */
async function readClarifications(runDir: string, briefText: string | null): Promise<ClarificationRound[]> {
  const rounds: ClarificationRound[] = [];

  if (briefText) {
    const round = parseOpenQuestions(briefText, { gate: 1, origin: "brief", source: RUN_FILES.brief });
    if (round) rounds.push(round);
  }

  // concept.md's own `## Open questions` — a Gate 2 stop, in the same shape.
  const conceptMd = await readIf(join(runDir, RUN_FILES.conceptMd));
  if (conceptMd) {
    const round = parseOpenQuestions(conceptMd, { gate: 2, origin: "concept", source: RUN_FILES.conceptMd });
    if (round?.questions.length) rounds.push(round);
  }

  // A stage that writes its questions to a file of their own — the builder's
  // questions.md, and the architect's refusal of a feedback finding, which carries the
  // ROUTE: line. Free-form, so the loose parser reads it.
  for (const rel of await walk(runDir)) {
    if (!/(^|\/)questions(-\d+)?\.md$/.test(rel)) continue;
    const text = await readIf(join(runDir, rel));
    if (!text) continue;
    const origin = rel.startsWith(RUN_FILES.packageDir) ? "build" : "feedback";
    const round = parseClarifications(text, { gate: origin === "build" ? 5 : "4a", origin, source: rel });
    if (round) rounds.push(round);
  }

  return rounds;
}
