/**
 * Where Studio looks for run directories.
 *
 * Two roots, and the difference between them is the whole point:
 *
 *   runs      `paths.runOutputDir` from val/config.json (default val/runs) — the live
 *             runs. Writable: this is where a feedback round, an answers file and an
 *             approval belong.
 *   fixtures  the target repo's tracked reference runs (default val/fixtures) —
 *             openable so a designer can read a real signed-off run end to end, and
 *             READ-ONLY. A fixture is a committed record; writing a round or an
 *             approval into one would put an unexplained diff in that repo, which is
 *             the same reason val-core's own resolveReport refuses to write beside a
 *             target outside the working directory.
 *
 * A fixture's id is namespaced (`fixtures:signed-off-run`) so it can never collide
 * with a live run of the same name, and so every code path that takes a run id knows
 * which root it is addressing without a second lookup.
 */
import { existsSync } from "node:fs";
import { normalize, relative, resolve } from "node:path";
import type { RunRootId, ValConfig } from "@valiify/studio-shared";
import { runOutputDirOf } from "../target-repo.ts";

export interface RunRoot {
  id: RunRootId;
  /** Absolute path. */
  dir: string;
  /** Repo-relative, as val/config.json spells it. */
  relDir: string;
  readOnly: boolean;
  /** False when the directory is not on disk. Reported, never silently treated as empty. */
  exists: boolean;
}

export const FIXTURES_PREFIX = "fixtures:";

export function runRoots(targetRepo: string, config: ValConfig, fixturesDir: string): RunRoot[] {
  const roots: RunRoot[] = [];
  const runsRel = runOutputDirOf(config);
  const runsDir = resolve(targetRepo, runsRel);
  roots.push({ id: "runs", dir: runsDir, relDir: runsRel, readOnly: false, exists: existsSync(runsDir) });

  if (fixturesDir) {
    const fixDir = resolve(targetRepo, fixturesDir);
    // Only when it is actually a distinct directory — a repo that points both at the
    // same place would otherwise list every run twice, once as writable and once not.
    if (fixDir !== runsDir) {
      roots.push({
        id: "fixtures",
        dir: fixDir,
        relDir: fixturesDir,
        readOnly: true,
        exists: existsSync(fixDir),
      });
    }
  }
  return roots;
}

/** The addressable id for a run directory under `root`. */
export function runKey(root: RunRoot, dirName: string): string {
  return root.id === "fixtures" ? `${FIXTURES_PREFIX}${dirName}` : dirName;
}

/** Split an addressable id back into its root and directory name. */
export function parseRunKey(runId: string): { rootId: RunRootId; name: string } {
  return runId.startsWith(FIXTURES_PREFIX)
    ? { rootId: "fixtures", name: runId.slice(FIXTURES_PREFIX.length) }
    : { rootId: "runs", name: runId };
}

/**
 * Resolve an id to a directory, refusing anything that escapes its root. Returns null
 * for an unknown root, a traversal attempt, or a directory that is not there.
 */
export function resolveRunDir(roots: RunRoot[], runId: string): { root: RunRoot; dir: string } | null {
  const { rootId, name } = parseRunKey(runId);
  const root = roots.find((r) => r.id === rootId);
  if (!root || !name) return null;
  const dir = resolve(root.dir, normalize(name));
  const rel = relative(root.dir, dir);
  if (!rel || rel.startsWith("..") || rel.includes("..")) return null;
  return existsSync(dir) ? { root, dir } : null;
}
