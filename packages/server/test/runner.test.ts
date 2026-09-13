/**
 * The runner's confinement policy, staleness, and the commit action.
 *
 * These three were all verified against the live SDK and the real repo before the
 * runner was written, and each test here pins a fact that probing established:
 *
 *   policy     `canUseTool` is never consulted once settingSources loads filesystem
 *              settings, and blocking a TOOL does not block an ACTION (a denied `cp`
 *              was completed with Read + Write). So confinement is path-based and
 *              enforced in the PreToolUse hook.
 *   staleness  an interrupted session leaves manifest.status at `running` for ever.
 *              Studio says so in the display and writes nothing to the run directory.
 *   commit     `val/runs/*` is gitignored in the real target repo, so the affirmative
 *              path was unreachable there and shipped untested. It is tested here in a
 *              throwaway git repo, which is the only way to reach it.
 */
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { bashTokens, checkTool, inside, type RunPolicy } from "../src/runner/policy.ts";
import { commitAllowed, commitRun, gitIgnoreRule, readGitState } from "../src/git.ts";
import { readRunSummary } from "../src/run/reader.ts";

const run = promisify(execFile);
const temps: string[] = [];
after(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const REPO = "/repo";
const POLICY: RunPolicy = { targetRepo: REPO, writeRoots: ["/repo/val/runs", "/repo/val/briefs"] };
const allowed = (tool: string, input: unknown) => checkTool(POLICY, tool, input).allow;
const refusal = (tool: string, input: unknown) => checkTool(POLICY, tool, input).reason ?? "";

describe("the confinement policy is path-based, not tool-based", () => {
  it("lets a run read anywhere in the target repo", () => {
    ok(allowed("Read", { file_path: "/repo/design-methodology/short-app.md" }));
    ok(allowed("Read", { file_path: "/repo/node_modules/@valiify/val-core/skills/design-methodology/SKILL.md" }));
    ok(allowed("Glob", { pattern: "**/*.css", path: "/repo/src" }));
    ok(allowed("Grep", { pattern: "^## ", path: "/repo/design-methodology" }));
  });

  it("refuses a read outside the target repo", () => {
    ok(!allowed("Read", { file_path: "/etc/passwd" }));
    ok(!allowed("Read", { file_path: "/Users/someone/.ssh/id_rsa" }));
    match(refusal("Read", { file_path: "/etc/passwd" }), /outside the target repo/);
  });

  it("lets a run write only inside its write roots", () => {
    ok(allowed("Write", { file_path: "/repo/val/runs/2026-09-13-design-x/manifest.json" }));
    ok(allowed("Write", { file_path: "/repo/val/briefs/brief-x.md" }));
    ok(allowed("Edit", { file_path: "/repo/val/runs/2026-09-13-design-x/01-brief.md" }));
  });

  it("refuses a write anywhere else, including elsewhere in the repo", () => {
    // The failure this exists to prevent: a run editing the library or the methodology.
    ok(!allowed("Write", { file_path: "/repo/src/components/button.css" }));
    ok(!allowed("Write", { file_path: "/repo/design-methodology/short-app.md" }));
    ok(!allowed("Write", { file_path: "/repo/val/config.json" }));
    ok(!allowed("Write", { file_path: "/tmp/anywhere.md" }));
    match(refusal("Write", { file_path: "/repo/design-methodology/short-app.md" }), /writes only inside/);
  });

  it("refuses anything touching .git, read or write or command", () => {
    ok(!allowed("Read", { file_path: "/repo/.git/config" }));
    ok(!allowed("Write", { file_path: "/repo/.git/hooks/pre-commit" }));
    ok(!allowed("Bash", { command: "git status" }));
    ok(!allowed("Bash", { command: "cat .git/HEAD" }));
    match(refusal("Bash", { command: "git status" }), /never runs git/);
  });

  it("closes the network", () => {
    ok(!allowed("WebFetch", { url: "https://example.com" }));
    ok(!allowed("WebSearch", { query: "how to make a button" }));
    ok(!allowed("Bash", { command: "curl https://example.com" }));
    match(refusal("WebFetch", { url: "https://x" }), /never from the network/);
  });

  it("allows the bash the pipeline actually needs", () => {
    ok(allowed("Bash", { command: "pwd" }));
    ok(allowed("Bash", { command: "mkdir -p /repo/val/runs/2026-09-13-design-x/00-input" }));
    ok(allowed("Bash", { command: "shasum -a 256 /repo/val/runs/r/02-concept/concept.v2.html" }));
    // The orchestrator re-runs the checks itself — Gate 2, Gate 4a, Gate 5.
    ok(allowed("Bash", { command: "node /repo/val/tools/design/feedback-check.mjs /repo/val/runs/r --out json" }));
    ok(allowed("Bash", { command: "node /repo/val/tools/design/class-audit.mjs /repo/val/runs/r/02-concept/concept.v1.html" }));
  });

  it("allows the exact bash the real Gate 0 issued, destinations checked", () => {
    // These are verbatim from an observed /design run against the real repo. Every one
    // must pass, or the policy silently hobbles the pipeline — the failure that is
    // indistinguishable from a slow run.
    ok(allowed("Bash", { command: 'mkdir -p "/repo/val/runs/2026-09-13-design-x/00-input"' }));
    ok(allowed("Bash", { command: 'cp "/repo/val/briefs/brief-x.md" "/repo/val/runs/2026-09-13-design-x/00-input/"' }));
    ok(allowed("Bash", { command: "head -1 /repo/.claude/agents/design-concept-architect.md" }));
    ok(allowed("Bash", { command: "pwd" }));
  });

  it("checks a copy's destination, not merely its readability", () => {
    // A copy OUT of the run directory is the interesting case: the source is readable,
    // so a policy that only asked "can it read this?" would wave it through.
    ok(!allowed("Bash", { command: "cp /repo/val/briefs/brief-x.md /repo/src/components/brief.md" }));
    ok(!allowed("Bash", { command: "cp /repo/val/config.json /repo/val/config.json.bak" }));
    match(refusal("Bash", { command: "cp /repo/val/config.json /repo/src/x.json" }), /writes only inside/);
    // mv is not on the list at all: it also removes the source.
    ok(!allowed("Bash", { command: "mv /repo/val/briefs/a.md /repo/val/runs/r/a.md" }));
  });

  it("refuses bash that chains, redirects or substitutes", () => {
    // A single allowed prefix stops meaning anything once a `;` is in play.
    ok(!allowed("Bash", { command: "pwd; rm -rf /repo/src" }));
    ok(!allowed("Bash", { command: "cat /repo/val/config.json > /repo/val/config.json.bak" }));
    ok(!allowed("Bash", { command: "echo $(whoami)" }));
    ok(!allowed("Bash", { command: "ls /repo && rm -rf /repo/src" }));
    // Observed in a real run: the orchestrator piped head into grep. Refusing it is
    // correct — Read and Grep do the same job inside the policy.
    ok(!allowed("Bash", { command: 'head -20 /repo/.claude/agents/design-concept-architect.md | grep "GENERATED"' }));
    match(refusal("Bash", { command: "pwd; ls" }), /chain, redirect or substitute/);
  });

  it("tokenises a repo path that contains spaces", () => {
    // A real false positive from a live run: the target repo is
    // "/Users/…/valiify shortapp library", and splitting on whitespace tore
    // `valiify\ shortapp\ library` into three fragments. The first resolved outside the
    // repo, so a perfectly legitimate command was refused. A check that refuses correct
    // input is a bug in the check.
    deepStrictEqual(bashTokens("ls /a/valiify\\ shortapp\\ library/val"), ["ls", "/a/valiify shortapp library/val"]);
    deepStrictEqual(bashTokens('cp "/a/b c/x.md" "/a/b c/y/"'), ["cp", "/a/b c/x.md", "/a/b c/y/"]);
    deepStrictEqual(bashTokens("cat '/a/b c/d.md'"), ["cat", "/a/b c/d.md"]);
    // Backslashes are literal inside single quotes, and escape inside double quotes.
    deepStrictEqual(bashTokens(`cat "/a/b\\"c"`), ["cat", '/a/b"c']);
    // Unbalanced quotes cannot be tokenised, so they cannot be checked.
    strictEqual(bashTokens('cat "/a/unterminated'), null);
  });

  it("allows a command naming a spaced repo path, however it is escaped", () => {
    const spaced: RunPolicy = {
      targetRepo: "/Users/me/valiify shortapp library",
      writeRoots: ["/Users/me/valiify shortapp library/val/runs"],
    };
    const ok_ = (cmd: string) => checkTool(spaced, "Bash", { command: cmd }).allow;
    ok(ok_("head -1 /Users/me/valiify\\ shortapp\\ library/.claude/agents/design-critic.md"));
    ok(ok_('head -1 "/Users/me/valiify shortapp library/.claude/agents/design-critic.md"'));
    ok(ok_("mkdir -p '/Users/me/valiify shortapp library/val/runs/r/00-input'"));
    // And it still refuses what is genuinely out of bounds, spaces or not.
    ok(!ok_('mkdir -p "/Users/me/valiify shortapp library/src/x"'));
    ok(!ok_("cat /Users/me/somewhere\\ else/secrets.txt"));
    strictEqual(checkTool(spaced, "Bash", { command: 'cat "/unterminated' }).allow, false);
  });

  it("allows read-only grep, which a real run reached for", () => {
    ok(allowed("Bash", { command: "grep -n GENERATED /repo/.claude/agents/design-critic.md" }));
    ok(!allowed("Bash", { command: "grep -n x /etc/passwd" }));
  });

  it("refuses a mkdir that would create a directory outside the write roots", () => {
    ok(!allowed("Bash", { command: "mkdir -p /repo/src/newthing" }));
    ok(!allowed("Bash", { command: "mkdir -p /tmp/elsewhere" }));
  });

  it("refuses tools that are not part of the pipeline at all", () => {
    ok(!allowed("KillShell", {}));
    ok(!allowed("BashOutput", { bash_id: "x" }));
    match(refusal("KillShell", {}), /not part of the design pipeline/);
  });

  it("lets subagent dispatch through — a subagent's own calls are hooked separately", () => {
    ok(allowed("Agent", { subagent_type: "design-brief-intake" }));
    // The tool is named Agent in the stream, not Task; both are accepted so an
    // allow-list written against either name cannot silently miss.
    ok(allowed("Task", { subagent_type: "design-critic" }));
    ok(allowed("TodoWrite", { todos: [] }));
  });

  it("compares resolved paths, so `..` cannot walk out of a write root", () => {
    ok(!allowed("Write", { file_path: "/repo/val/runs/../../src/evil.css" }));
    ok(!allowed("Read", { file_path: "/repo/../../../etc/passwd" }));
    ok(inside("/repo", "/repo/val/runs"));
    ok(!inside("/repo/val/runs", "/repo/val/briefs"));
  });

  it("confines a build tighter than a design run", () => {
    // /design build knows its run directory exactly; /design does not, because Gate 0
    // names it. So a build's write root is the one directory.
    const buildPolicy: RunPolicy = { targetRepo: REPO, writeRoots: ["/repo/val/runs/r1"] };
    ok(checkTool(buildPolicy, "Write", { file_path: "/repo/val/runs/r1/05-package/contract.json" }).allow);
    ok(!checkTool(buildPolicy, "Write", { file_path: "/repo/val/runs/r2/manifest.json" }).allow);
    ok(!checkTool(buildPolicy, "Write", { file_path: "/repo/val/briefs/brief-x.md" }).allow);
  });
});

describe("an abandoned run is a display fact, never a written one", () => {
  /** A run directory whose manifest says `running` and whose files are old. */
  async function stubbornRun(ageMs: number): Promise<string> {
    const dir = await scratch("studio-stale-");
    await mkdir(join(dir, "00-input"), { recursive: true });
    await writeFile(join(dir, "00-input", "brief.md"), "# brief\n");
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({ kind: "design", runId: "r", status: "running", gates: [] }),
    );
    const when = new Date(Date.now() - ageMs);
    const { utimes } = await import("node:fs/promises");
    for (const p of [join(dir, "manifest.json"), join(dir, "00-input", "brief.md"), join(dir, "00-input"), dir]) {
      await utimes(p, when, when);
    }
    return dir;
  }

  it("reports a long-quiet `running` run as stale, with when it last did anything", async () => {
    const dir = await stubbornRun(30 * 60_000);
    const s = await readRunSummary(dir, dir, undefined, 15 * 60_000);
    strictEqual(s.status, "running", "the manifest still says running — only a gate rewrites that");
    strictEqual(s.stale, true);
    ok(Date.now() - Date.parse(s.lastActivityAt) > 25 * 60_000, "lastActivityAt is the real mtime");
    strictEqual(s.staleAfterMs, 15 * 60_000);
  });

  it("does not call a working run stale just because a stage is slow", async () => {
    const dir = await stubbornRun(2 * 60_000);
    const s = await readRunSummary(dir, dir, undefined, 15 * 60_000);
    strictEqual(s.stale, false, "a concept architect legitimately runs for many minutes");
  });

  it("never calls a run that is waiting on a human stale", async () => {
    // awaiting-requester and awaiting-approval are correct, indefinite waits: the
    // pipeline is doing exactly what it should, which is nothing.
    const dir = await scratch("studio-waiting-");
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({ kind: "design", runId: "r", status: "awaiting-approval", gates: [] }),
    );
    const when = new Date(Date.now() - 5 * 60 * 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(join(dir, "manifest.json"), when, when);
    await utimes(dir, when, when);
    const s = await readRunSummary(dir, dir, undefined, 15 * 60_000);
    strictEqual(s.stale, false);
  });

  it("writes nothing into the run directory to record any of it", async () => {
    const dir = await stubbornRun(30 * 60_000);
    const { readdir } = await import("node:fs/promises");
    const before = (await readdir(dir)).sort();
    await readRunSummary(dir, dir, undefined, 15 * 60_000);
    deepStrictEqual((await readdir(dir)).sort(), before, "the run directory belongs to the pipeline");
  });
});

describe("the commit action", () => {
  /** A throwaway repo with a signed-off run in it — the only way to reach the yes path. */
  async function repoWithRun(ignoreRuns: boolean): Promise<{ repo: string; runDir: string }> {
    const repo = await scratch("studio-git-");
    await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await run("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await run("git", ["config", "user.name", "Test"], { cwd: repo });
    if (ignoreRuns) await writeFile(join(repo, ".gitignore"), "val/runs/*\n");
    await writeFile(join(repo, "README.md"), "seed\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-qm", "seed"], { cwd: repo });

    const runDir = join(repo, "val/runs/2026-09-13-design-x");
    await mkdir(join(runDir, "05-package"), { recursive: true });
    await writeFile(join(runDir, "manifest.json"), JSON.stringify({ kind: "design", status: "signed-off" }));
    await writeFile(join(runDir, "04-approval.md"), "sealed\n");
    await writeFile(join(runDir, "07-writeup.md"), "done\n");
    return { repo, runDir };
  }

  it("COMMITS a signed-off run when the directory is tracked", async () => {
    // The affirmative path. It was unreachable in the real target repo, where
    // val/runs/* is ignored, and that is how it shipped untested.
    const { repo, runDir } = await repoWithRun(false);
    const state = await readGitState(repo, runDir, "signed-off");
    strictEqual(state.ignoredByGit, false);
    strictEqual(state.hasUncommittedChanges, true);
    strictEqual(state.commitOffered, true, "a tracked, dirty, signed-off run IS offered");
    strictEqual(state.commitWithheldReason, undefined);

    const result = await commitRun(repo, runDir, "signed-off", "design: sign off x");
    strictEqual(result.committed, true, result.refusedReason);
    ok(result.sha, "a sha comes back");

    const { stdout } = await run("git", ["show", "--stat", "--format=%s", "HEAD"], { cwd: repo });
    match(stdout, /design: sign off x/);
    match(stdout, /val\/runs\/2026-09-13-design-x\/04-approval\.md/);

    // And the run directory is clean afterwards, so it is not offered twice.
    const after = await readGitState(repo, runDir, "signed-off");
    strictEqual(after.hasUncommittedChanges, false);
    strictEqual(after.commitOffered, false);
  });

  it("commits ONLY this run's directory, never the rest of the tree", async () => {
    const { repo, runDir } = await repoWithRun(false);
    await writeFile(join(repo, "unrelated.txt"), "not this run's business\n");
    await commitRun(repo, runDir, "signed-off");
    const { stdout } = await run("git", ["status", "--porcelain"], { cwd: repo });
    match(stdout, /unrelated\.txt/, "the unrelated file is still uncommitted");
  });

  it("explains the .gitignore instead of offering a button that does nothing", async () => {
    const { repo, runDir } = await repoWithRun(true);
    const rule = await gitIgnoreRule(repo, "val/runs/2026-09-13-design-x");
    ok(rule, "check-ignore names the rule");
    match(rule!, /val\/runs/);

    const state = await readGitState(repo, runDir, "signed-off");
    strictEqual(state.ignoredByGit, true);
    strictEqual(state.commitOffered, false, "an ignored directory can never be committed as it stands");
    ok(state.ignoreRule);
    match(state.commitWithheldReason!, /excluded from git/);
    match(state.commitWithheldReason!, /reference runs somewhere tracked/);

    const result = await commitRun(repo, runDir, "signed-off");
    strictEqual(result.committed, false);
    match(result.refusedReason!, /excluded from git/);
  });

  it("still refuses an intermediate gate, tracked or not", async () => {
    const { repo, runDir } = await repoWithRun(false);
    for (const stage of ["concept", "critique", "awaiting-approval", "approved", "build", "verified"] as const) {
      ok(!commitAllowed(stage));
      const r = await commitRun(repo, runDir, stage);
      strictEqual(r.committed, false, `${stage} must not commit`);
      match(r.refusedReason!, /signed-off/);
    }
  });
});
