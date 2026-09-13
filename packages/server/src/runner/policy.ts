/**
 * What a pipeline run is allowed to do — enforced by Studio, not by the operator's
 * settings.
 *
 * Two findings from the SDK probes decide the shape of this file:
 *
 *   1. `canUseTool` is never consulted once settingSources loads filesystem settings.
 *      Every tool, Bash included, was auto-allowed by the operator's own
 *      `permissions.allow`. The only mechanism that actually gates is a PreToolUse
 *      hook returning `permissionDecision: "deny"` — which DOES override an inherited
 *      allow (proven: it denied a `head -1` and a `cp` the settings had allowed).
 *
 *   2. Blocking a TOOL does not block an ACTION. When the probe denied `cp`, the
 *      orchestrator completed the same copy with Read + Write and carried on. So
 *      confinement is path-based: it asks where a call would read or write, never
 *      which tool is asking.
 *
 * The policy: a run may READ anywhere inside the target repo, may WRITE only inside
 * its own write roots, and may do nothing at all to `.git` or the network.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface RunPolicy {
  /** Absolute path to the target repo. Reads are confined to it. */
  targetRepo: string;
  /**
   * Absolute directories this run may write into.
   *
   * `/design build <run-dir>` knows its run directory exactly, so it gets just that
   * one. `/design <brief>` does NOT: Gate 0 names the directory, not Studio, so the
   * best honest bound is the runs root plus the briefs directory. Narrowing that
   * would mean predicting a name the pipeline owns.
   */
  writeRoots: string[];
}

export interface PolicyVerdict {
  allow: boolean;
  /** Why it was refused — relayed to the model, so it must say what would be allowed. */
  reason?: string;
}

const ALLOW: PolicyVerdict = { allow: true };
const deny = (reason: string): PolicyVerdict => ({ allow: false, reason });

/** Tools that only read. Their paths must land inside the target repo. */
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead", "LS"]);
/** Tools that write a file. Their paths must land inside a write root. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Dispatch and bookkeeping. A subagent's own calls are hooked separately. */
const PASSTHROUGH = new Set(["Agent", "Task", "TodoWrite", "ExitPlanMode"]);
/** The network is closed. The pipeline composes from the library and the methodology. */
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);

/**
 * Bash command shapes the pipeline genuinely needs.
 *
 * From the observed Gate 0 → Gate 1 trace and the orchestrator template: `mkdir -p`
 * for the run directory, `shasum -a 256` for the Gate 4b seal, and `node
 * <tools-dir>/design/<tool>.mjs` for the class-audit / feedback-check / handoff-check
 * re-runs the orchestrator performs itself. The rest are read-only inspection.
 */
const BASH_ALLOW: RegExp[] = [
  /^pwd$/,
  /^date\b/,
  /^mkdir\s+-p\s+/,
  // Gate 0 step 2 copies the brief into 00-input/. Both endpoints are checked below.
  /^cp\s+/,
  /^shasum\s+-a\s+256\s+/,
  /^(ls|cat|head|tail|wc|file|find|grep)\s+/,
  /^node\s+\S*tools\/design\/[a-z-]+\.mjs\b/,
];

/**
 * Commands whose LAST path argument is a destination they write to.
 *
 * `mv` is deliberately absent: it writes the destination and removes the source, and a
 * source is only ever guaranteed readable. A run that needs to move something can copy
 * it.
 */
const WRITES_TO_LAST_ARG = /^cp\s/;
/** Commands where every path argument is something they create. */
const WRITES_TO_EVERY_ARG = /^mkdir\s/;

/**
 * Shell metacharacters that chain, redirect or substitute. A single allowed prefix
 * stops meaning anything once a `;` or a `$(` is in play, so any command carrying one
 * is refused outright rather than parsed.
 */
const SHELL_CONTROL = /[;&|><`\n]|\$\(/;

/** Binaries that reach the network, whatever the surrounding command looks like. */
const NETWORK_BINARIES = /\b(curl|wget|nc|ncat|telnet|ssh|scp|rsync|npm|npx|pnpm|yarn|pip|pip3|brew)\b/;

/** `.git` is off limits entirely — reading it, writing it, or running git. */
function touchesGit(p: string): boolean {
  return p.split(/[/\\]/).includes(".git");
}

/** Is `p` inside `root` (or equal to it)? Compared as resolved paths, never as strings. */
export function inside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Every value in a tool input that names a file path. */
function pathsIn(input: Record<string, unknown>): string[] {
  const keys = ["file_path", "notebook_path", "path", "filePath", "dir", "directory"];
  const out: string[] = [];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v) out.push(v);
  }
  const edits = input.edits;
  if (Array.isArray(edits)) {
    for (const e of edits) {
      const v = (e as Record<string, unknown>)?.file_path;
      if (typeof v === "string" && v) out.push(v);
    }
  }
  return out;
}

/**
 * Split a command into arguments the way a shell would.
 *
 * Splitting on whitespace is wrong and was a real false positive: the target repo path
 * contains spaces, so `ls /Users/me/valiify\ shortapp\ library` tokenised into three
 * fragments, the first of which resolved outside the repo and got the command refused.
 * A check that refuses a legitimate command is a bug in the check.
 *
 * Returns null for an unterminated quote — a command that cannot be tokenised cannot be
 * checked, and the caller refuses it rather than guessing.
 */
export function bashTokens(command: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      // Inside double quotes a backslash escapes; inside single quotes it is literal.
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        cur += command[++i];
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      // `valiify\ shortapp` — one argument, not two.
      cur += command[++i];
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (quote) return null;
  if (started) out.push(cur);
  return out;
}

/**
 * Every argument of a bash command that names a filesystem path. Flags and bare words
 * are ignored; anything containing a separator or starting at `~` is treated as a path.
 */
function bashPaths(command: string): string[] | null {
  const tokens = bashTokens(command);
  if (tokens === null) return null;
  return tokens.slice(1).filter((a) => a && !a.startsWith("-") && (a.includes("/") || a.startsWith("~")));
}

export function checkTool(
  policy: RunPolicy,
  toolName: string,
  rawInput: unknown,
): PolicyVerdict {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const abs = (p: string) => resolve(policy.targetRepo, p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));

  if (NETWORK_TOOLS.has(toolName)) {
    return deny(
      `${toolName} is refused: a design run composes from the library and the methodology on disk, never from the network.`,
    );
  }

  if (PASSTHROUGH.has(toolName)) return ALLOW;

  if (READ_TOOLS.has(toolName)) {
    for (const p of pathsIn(input)) {
      const a = abs(p);
      if (touchesGit(a)) return deny(`Refused: ${p} is inside .git, which a design run never touches.`);
      if (!inside(policy.targetRepo, a)) {
        return deny(`Refused: ${p} is outside the target repo. A design run reads only inside ${policy.targetRepo}.`);
      }
    }
    return ALLOW;
  }

  if (WRITE_TOOLS.has(toolName)) {
    const paths = pathsIn(input);
    if (!paths.length) return deny(`Refused: ${toolName} named no path to check.`);
    for (const p of paths) {
      const a = abs(p);
      if (touchesGit(a)) return deny(`Refused: ${p} is inside .git, which a design run never touches.`);
      if (!policy.writeRoots.some((root) => inside(root, a))) {
        return deny(
          `Refused: a design run writes only inside ${policy.writeRoots.join(" and ")}. ${p} is outside that.`,
        );
      }
    }
    return ALLOW;
  }

  if (toolName === "Bash") {
    const command = String(input.command ?? "").trim();
    if (!command) return deny("Refused: empty bash command.");
    if (SHELL_CONTROL.test(command)) {
      return deny(
        "Refused: bash commands that chain, redirect or substitute (`;` `&&` `|` `>` backticks `$()`) are not permitted. Run one plain command, or use Read/Write.",
      );
    }
    if (/^git\b/.test(command) || touchesGit(command)) {
      return deny("Refused: a design run never runs git or touches .git. Studio handles version control separately.");
    }
    if (NETWORK_BINARIES.test(command)) {
      return deny(`Refused: ${command.split(/\s+/)[0]} can reach the network or mutate the environment.`);
    }
    if (!BASH_ALLOW.some((re) => re.test(command))) {
      return deny(
        `Refused: "${command.split(/\s+/)[0]}" is not on the design run's bash allow-list (pwd, date, mkdir -p, shasum, ls/cat/head/tail/wc/file/find, and node <tools-dir>/design/*.mjs). Use Read, Write, Glob or Grep instead.`,
      );
    }
    // The command shape is allowed; its arguments still have to stay in bounds. Which
    // arguments are DESTINATIONS depends on the command, so read-only arguments are not
    // held to the write roots and destinations are not merely checked for readability.
    const paths = bashPaths(command);
    if (paths === null) {
      return deny("Refused: unbalanced quotes — a command that cannot be parsed cannot be checked.");
    }
    const destinations = new Set<string>(
      WRITES_TO_EVERY_ARG.test(command)
        ? paths
        : WRITES_TO_LAST_ARG.test(command) && paths.length
          ? [paths[paths.length - 1]]
          : [],
    );
    for (const p of paths) {
      const a = abs(p);
      if (touchesGit(a)) return deny(`Refused: ${p} is inside .git.`);
      if (!inside(policy.targetRepo, a)) {
        return deny(`Refused: ${p} is outside the target repo.`);
      }
      if (destinations.has(p) && !policy.writeRoots.some((root) => inside(root, a))) {
        return deny(
          `Refused: a design run writes only inside ${policy.writeRoots.join(" and ")}. ${p} is outside that.`,
        );
      }
    }
    if (destinations.size === 0 && WRITES_TO_LAST_ARG.test(command)) {
      return deny("Refused: a copy with no destination argument cannot be checked.");
    }
    return ALLOW;
  }

  return deny(
    `Refused: ${toolName} is not part of the design pipeline's tool set. The run composes from files in the target repo.`,
  );
}

/** Human-readable summary of a policy, for the startup banner and the run log. */
export function describePolicy(policy: RunPolicy): string {
  return [
    `reads:  ${policy.targetRepo}`,
    `writes: ${policy.writeRoots.map((r) => relative(policy.targetRepo, r) || ".").join(", ")}`,
    `denied: .git, the network, and every bash command off the allow-list`,
  ].join(` ${sep === "/" ? "·" : "|"} `);
}
