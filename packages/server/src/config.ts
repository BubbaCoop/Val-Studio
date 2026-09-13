/**
 * Studio's own configuration — where the target repo is, and how to serve.
 *
 * Deliberately tiny: Studio owns no database and no state of its own. Everything
 * about a run lives in the run directory and git.
 */
import { resolve } from "node:path";

export interface StudioConfig {
  /** Absolute path to the target library repo. May contain spaces — never shell-interpolated. */
  targetRepo: string;
  port: number;
  host: string;
  /**
   * `stub` proves the architecture without spending agent tokens. The preflight is
   * real either way — a stub runner against a repo that was never val-inited is
   * still a misconfiguration Studio must refuse to hide.
   */
  runner: "stub" | "agent-sdk";
  /** Fail startup when the preflight fails. Off only for tests. */
  strictPreflight: boolean;
  /**
   * Repo-relative directory of tracked reference runs, listed alongside the live ones
   * and always READ-ONLY. There is no val.config.schema.json field for this — it is
   * Studio's convention, not the pipeline's — so it is Studio configuration. Set it
   * empty to list nothing but the live runs.
   */
  fixturesDir: string;
  /**
   * Model pinned for pipeline runs. The manifest records a model on every gate and the
   * orchestrator treats a gate that ran on a different model as a finding, so leaving
   * this to an inherited default would make that check meaningless.
   */
  model?: string;
  /** How long a run may claim `running` without touching a file before it shows as stale. */
  staleAfterMs: number;
}

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith(prefix)) return a.slice(prefix.length);
    if (a === `--${name}`) return process.argv[i + 1];
  }
  return undefined;
}

export function loadConfig(): StudioConfig {
  const target = flag("target") ?? process.env.VAL_STUDIO_TARGET_REPO;
  if (!target) {
    throw new Error(
      "No target repo. Pass --target '<path to the library repo>' or set VAL_STUDIO_TARGET_REPO.\n" +
        "Studio drives the /design pipeline against a library repo on disk; it has no library of its own.",
    );
  }
  const runner = (flag("runner") ?? process.env.VAL_STUDIO_RUNNER ?? "stub") as StudioConfig["runner"];
  if (runner !== "stub" && runner !== "agent-sdk") {
    throw new Error(`Unknown runner "${runner}" — expected "stub" or "agent-sdk".`);
  }
  return {
    targetRepo: resolve(target),
    port: Number(flag("port") ?? process.env.PORT ?? 4317),
    host: flag("host") ?? process.env.HOST ?? "127.0.0.1",
    runner,
    strictPreflight: (flag("strict-preflight") ?? process.env.VAL_STUDIO_STRICT_PREFLIGHT ?? "1") !== "0",
    fixturesDir: flag("fixtures") ?? process.env.VAL_STUDIO_FIXTURES_DIR ?? "val/fixtures",
    model: flag("model") ?? process.env.VAL_STUDIO_MODEL,
    staleAfterMs: Number(flag("stale-after-ms") ?? process.env.VAL_STUDIO_STALE_AFTER_MS ?? 15 * 60_000),
  };
}
