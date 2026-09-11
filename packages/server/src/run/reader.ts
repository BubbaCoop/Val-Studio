/**
 * Reading a run directory into the typed model the frontend consumes.
 *
 * The run directory and git are the only state Studio has. Nothing here caches, and
 * nothing here writes — this module is pure read, so it can be called on every file
 * event without a consistency problem.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type {
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
import { parseOpenQuestions } from "../parse/clarification.ts";
import { readTable, section } from "../parse/tables.ts";
import { readGitState } from "../git.ts";
import { deriveStage } from "./stage.ts";
import { PATTERNS, RUN_FILES, numbered, walk } from "./paths.ts";

const FINDING_COLUMNS = ["id", "block", "severity", "rule", "finding", "fix"];

async function readIf(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  const text = await readIf(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A half-written manifest is normal while an agent is mid-write; the next
    // watcher event re-reads it. Never throw the whole run away over one bad read.
    return null;
  }
}

/**
 * The verdict line. The methodology documents `CRITIQUE: FAIL | FINDINGS: 3 | BLOCKING: 2`,
 * and the real fixtures in the target repo write `**VERDICT: PASS** — …`. Both are
 * accepted; guessing which one a given stage used would make the reader wrong half
 * the time.
 */
function verdictOf(text: string, keyword: string): { verdict: string; findings?: number; blocking?: number } {
  const line = new RegExp(`\\*{0,2}(?:${keyword}|VERDICT)\\*{0,2}\\s*:\\s*\\*{0,2}(PASS|FAIL|OK|BLOCKED)`, "i").exec(text);
  const findings = /FINDINGS\s*:\s*(\d+)/i.exec(text);
  const blocking = /BLOCKING\s*:\s*(\d+)/i.exec(text);
  return {
    verdict: (line?.[1] ?? "UNKNOWN").toUpperCase(),
    findings: findings ? Number(findings[1]) : undefined,
    blocking: blocking ? Number(blocking[1]) : undefined,
  };
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

/** A cheap summary: manifest plus a directory listing, with no markdown parsed. */
export async function readRunSummary(repo: string, runDir: string): Promise<RunSummary> {
  const manifest = await readJson<Manifest>(join(runDir, RUN_FILES.manifest));
  const concepts = await conceptVersions(runDir);
  const critiques = await numbered(runDir, PATTERNS.critique);
  const verifies = await numbered(runDir, PATTERNS.verify);
  const brief = await readIf(join(runDir, RUN_FILES.brief));

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

  const mtime = await stat(runDir)
    .then((s) => s.mtime.toISOString())
    .catch(() => new Date(0).toISOString());

  return {
    // The directory is the identity — see RunSummary.runId.
    runId: basename(runDir),
    manifestRunId: manifest?.runId && manifest.runId !== basename(runDir) ? manifest.runId : undefined,
    path: runDir,
    relPath: relative(repo, runDir),
    surface: manifest?.surface,
    status: manifest?.status ?? "running",
    stage,
    loops: loopState(manifest),
    conceptVersions: concepts.length,
    hasApproval: existsSync(join(runDir, RUN_FILES.approval)),
    hasPackage: existsSync(join(runDir, RUN_FILES.packageDir)),
    updatedAt: mtime,
    manifestMissing: manifest === null,
  };
}

/** Does 01-brief.md carry a BLOCKING question? Parsed, not guessed from the manifest. */
function briefIsBlocked(brief: string): boolean {
  const round = parseOpenQuestions(brief, { gate: 1, origin: "brief", source: RUN_FILES.brief });
  return !!round?.questions.some((q) => q.blocking);
}

export async function readRunDetail(repo: string, runDir: string): Promise<RunDetail> {
  const summary = await readRunSummary(repo, runDir);
  const manifest = await readJson<Manifest>(join(runDir, RUN_FILES.manifest));

  const briefText = await readIf(join(runDir, RUN_FILES.brief));
  const clarifications = [];
  if (briefText) {
    const round = parseOpenQuestions(briefText, { gate: 1, origin: "brief", source: RUN_FILES.brief });
    if (round) clarifications.push(round);
  }

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

  const contract = await readJson<DesignContract>(join(runDir, RUN_FILES.contract));
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

/** Every run directory under the configured runOutputDir, newest first. */
export async function listRuns(repo: string, runOutputDir: string): Promise<RunSummary[]> {
  const root = join(repo, runOutputDir);
  const { readdir } = await import("node:fs/promises");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = await Promise.all(
    entries.filter((e) => e.isDirectory()).map((e) => readRunSummary(repo, join(root, e.name))),
  );
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
