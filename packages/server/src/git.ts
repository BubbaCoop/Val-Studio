/**
 * Git — read freely, write only when the user explicitly asks.
 *
 * The backend NEVER commits automatically. An agent pipeline writing dozens of
 * files should not also be producing commits nobody asked for. The commit action is
 * offered at `signed-off` and nowhere else: that is where the run directory holds
 * the sha256-sealed approval and the verified package, and is worth a durable
 * record. At an intermediate gate the answer is always no.
 *
 * Every invocation passes arguments as an array — the target repo path contains
 * spaces, and nothing here is ever interpolated into a shell string.
 */
import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";
import type { GitState, RunStage } from "@valiify/studio-shared";

const run = promisify(execFile);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: repo, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** Only a signed-off run is worth a durable record. */
export function commitAllowed(stage: RunStage): boolean {
  return stage === "signed-off";
}

/**
 * Is this path excluded by .gitignore, and by which rule?
 *
 * Worth asking before offering a commit. A run under an ignored path never shows as
 * dirty, so `git status` reports nothing and the action would silently do nothing —
 * which is how a dead button gets shipped. `check-ignore -v` names the rule, so the
 * refusal can say WHY rather than just no.
 */
export async function gitIgnoreRule(repo: string, rel: string): Promise<string | null> {
  try {
    const out = await git(repo, ["check-ignore", "-v", "--", rel]);
    return out.trim() || null;
  } catch {
    // Exit 1 means "not ignored"; anything else means git could not answer, and a
    // path we cannot classify is treated as not ignored so the normal rules apply.
    return null;
  }
}

export async function readGitState(repo: string, runDir: string, stage: RunStage): Promise<GitState> {
  const rel = relative(repo, runDir) || ".";
  try {
    await git(repo, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { isRepo: false, dirtyPaths: [], hasUncommittedChanges: false, commitOffered: false };
  }

  let branch: string | undefined;
  try {
    branch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    /* a repo with no commits yet has no HEAD */
  }

  // `--porcelain` over the run dir only: a dirty file elsewhere in the library is
  // not this run's business, and must never be swept into this run's commit.
  const porcelain = await git(repo, ["status", "--porcelain", "--untracked-files=all", "--", rel]);
  const dirtyPaths = porcelain
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .map((p) => (p.startsWith(rel) ? p.slice(rel.length).replace(/^\//, "") : p));

  let lastCommit: GitState["lastCommit"];
  try {
    const log = (await git(repo, ["log", "-1", "--format=%h%x00%s%x00%cI", "--", rel])).trim();
    if (log) {
      const [sha, subject, at] = log.split("\0");
      lastCommit = { sha, subject, at };
    }
  } catch {
    /* no history for this path */
  }

  const ignore = await gitIgnoreRule(repo, rel);
  const allowed = commitAllowed(stage);
  const hasUncommittedChanges = dirtyPaths.length > 0;
  const offered = allowed && hasUncommittedChanges && !ignore;

  return {
    isRepo: true,
    branch,
    dirtyPaths,
    hasUncommittedChanges,
    lastCommit,
    commitOffered: offered,
    ignoredByGit: !!ignore,
    ignoreRule: ignore ?? undefined,
    commitWithheldReason: offered ? undefined : withheldReason({ stage, allowed, hasUncommittedChanges, ignore, rel }),
  };
}

/** Say plainly why the commit is not on offer. Never just "no". */
function withheldReason(o: {
  stage: RunStage;
  allowed: boolean;
  hasUncommittedChanges: boolean;
  ignore: string | null;
  rel: string;
}): string | undefined {
  if (o.ignore) {
    return (
      `${o.rel} is excluded from git by ${o.ignore.split("\t")[0]}, so git will never see it as changed and ` +
      `committing it here would do nothing. That exclusion is why a repo keeps its reference runs somewhere ` +
      `tracked instead. To keep a durable record of this run, copy it into the tracked fixtures directory, or ` +
      `remove the ignore rule if every run should be committed.`
    );
  }
  if (!o.allowed) {
    return (
      `This run is at "${o.stage}". A run is committed at signed-off, where the directory holds the sealed ` +
      `approval and the verified package — never at an intermediate gate.`
    );
  }
  if (!o.hasUncommittedChanges) return "Nothing to commit — this run directory is already clean.";
  return undefined;
}

export interface CommitResult {
  committed: boolean;
  sha?: string;
  message?: string;
  refusedReason?: string;
}

/** Stage and commit ONLY this run's directory. Called from the explicit UI action. */
export async function commitRun(
  repo: string,
  runDir: string,
  stage: RunStage,
  message?: string,
): Promise<CommitResult> {
  if (!commitAllowed(stage)) {
    return {
      committed: false,
      refusedReason: `Refusing to commit a run at "${stage}". The commit action is offered at signed-off only.`,
    };
  }
  const rel = relative(repo, runDir) || ".";
  const state = await readGitState(repo, runDir, stage);
  if (!state.isRepo) return { committed: false, refusedReason: "The target repo is not a git work tree." };
  // An ignored run directory is the usual case, and `git add` on it is a silent no-op.
  if (state.ignoredByGit) {
    return { committed: false, refusedReason: state.commitWithheldReason };
  }
  if (!state.hasUncommittedChanges) {
    return { committed: false, refusedReason: "Nothing to commit — this run directory is already clean." };
  }

  const subject = message?.trim() || `design: sign off ${rel.split("/").pop()}`;
  await git(repo, ["add", "--", rel]);
  await git(repo, ["commit", "-m", subject, "--", rel]);
  const sha = (await git(repo, ["rev-parse", "--short", "HEAD"])).trim();
  return { committed: true, sha, message: subject };
}
