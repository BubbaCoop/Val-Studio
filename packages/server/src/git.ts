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

  const allowed = commitAllowed(stage);
  const hasUncommittedChanges = dirtyPaths.length > 0;
  return {
    isRepo: true,
    branch,
    dirtyPaths,
    hasUncommittedChanges,
    lastCommit,
    commitOffered: allowed && hasUncommittedChanges,
    commitWithheldReason:
      !allowed && hasUncommittedChanges
        ? `This run is at "${stage}". A run is committed at signed-off, where the directory holds the sealed approval and the verified package — never at an intermediate gate.`
        : undefined,
  };
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
  if (!state.hasUncommittedChanges) {
    return { committed: false, refusedReason: "Nothing to commit — this run directory is already clean." };
  }

  const subject = message?.trim() || `design: sign off ${rel.split("/").pop()}`;
  await git(repo, ["add", "--", rel]);
  await git(repo, ["commit", "-m", subject, "--", rel]);
  const sha = (await git(repo, ["rev-parse", "--short", "HEAD"])).trim();
  return { committed: true, sha, message: subject };
}
