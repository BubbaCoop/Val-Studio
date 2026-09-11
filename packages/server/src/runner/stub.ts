/**
 * The stub runner — architecture proof, not a pipeline.
 *
 * It does NOT generate anything. It records the exact prompt a real runner would
 * send, emits token-level progress, and — when pointed at a fixture — REPLAYS that
 * recorded run's files into the run directory on a delay. Replaying is how the
 * watcher → SSE → screen path is proven end to end without spending agent tokens:
 * every file lands the way an agent would land it, and Studio learns about it the
 * same way it would learn about a run driven from the CLI.
 *
 * What it deliberately never does: invent a concept, decide a gate passed, or
 * compute an approval hash. The fixture's own 04-approval.md is copied verbatim,
 * hash included, because computing that seal is `/design build`'s job and nobody
 * else's.
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PreflightResult } from "@valiify/studio-shared";
import { walk } from "../run/paths.ts";
import { runPreflight } from "./preflight.ts";
import type { DesignRunner, RunnerInvocation, RunnerResult } from "./types.ts";

/** Replay order mirrors the gate order, so stages transition the way a real run does. */
const DESIGN_PHASES: { match: RegExp; agent: string; label: string }[] = [
  { match: /^01-brief\.md$/, agent: "design-brief-intake", label: "Gate 1 — intake" },
  { match: /^02-concept\/concept\.v1\.html$/, agent: "design-concept-architect", label: "Gate 2 — concept" },
  { match: /^02-concept\/concept\.md$/, agent: "design-concept-architect", label: "Gate 2 — concept.md" },
  { match: /^03-critique-1\.md$/, agent: "design-critic", label: "Gate 3 — critique 1" },
  { match: /^02-concept\/concept\.v2\.html$/, agent: "design-concept-architect", label: "Gate 3 — rework" },
  { match: /^02-concept\/fix-ledger\.md$/, agent: "design-concept-architect", label: "Gate 3 — fix ledger" },
  { match: /^03-critique-2\.md$/, agent: "design-critic", label: "Gate 3 — critique 2" },
];

const BUILD_PHASES: { match: RegExp; agent: string; label: string }[] = [
  { match: /^04-approval\.md$/, agent: "orchestrator", label: "Gate 4b — seal (copied verbatim; never computed here)" },
  { match: /^05-package\//, agent: "design-page-builder", label: "Gate 5 — build" },
  { match: /^06-verify-\d+\.md$/, agent: "design-handoff-verifier", label: "Gate 6 — verify" },
  { match: /^07-writeup\.md$/, agent: "orchestrator", label: "Gate 7 — writeup" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StubDesignRunner implements DesignRunner {
  readonly kind = "stub" as const;
  /** Absolute path to a recorded run to replay. Unset = record the prompt and stop. */
  fixture?: string;
  stepMs: number;

  constructor(opts: { fixture?: string; stepMs?: number } = {}) {
    this.fixture = opts.fixture;
    this.stepMs = opts.stepMs ?? 700;
  }

  /** Real, always. A stub against a repo that was never val-inited is still broken. */
  preflight(targetRepo: string): Promise<PreflightResult> {
    return runPreflight(targetRepo);
  }

  design(inv: RunnerInvocation): Promise<RunnerResult> {
    return this.replay(inv, DESIGN_PHASES, "design");
  }

  build(inv: RunnerInvocation): Promise<RunnerResult> {
    return this.replay(inv, BUILD_PHASES, "build");
  }

  private async replay(
    inv: RunnerInvocation,
    phases: { match: RegExp; agent: string; label: string }[],
    kind: string,
  ): Promise<RunnerResult> {
    // The prompt is recorded exactly as a real runner would send it: `/design …` is
    // prompt TEXT, processed in the prompt stream, not an API parameter.
    await this.note(inv, `[stub:${kind}] prompt: ${inv.prompt}`);
    inv.onProgress?.({ agent: "orchestrator", text: `stub runner — would send: ${inv.prompt}` });

    if (!this.fixture || !existsSync(this.fixture)) {
      return {
        ok: false,
        error:
          "Stub runner has no fixture to replay. Set VAL_STUDIO_STUB_FIXTURE to a recorded run " +
          "directory to exercise the watcher, or run with --runner=agent-sdk once real runs are wired in.",
      };
    }

    const files = await walk(this.fixture);
    const ordered = phases
      .map((p) => ({ phase: p, files: files.filter((f) => p.match.test(f)).sort() }))
      .filter((g) => g.files.length);

    for (const group of ordered) {
      if (inv.signal?.aborted) return { ok: false, error: "stopped" };
      inv.onProgress?.({ agent: group.phase.agent, text: group.phase.label });
      for (const rel of group.files) {
        const dest = join(inv.ctx.runDir, rel);
        await mkdir(dirname(dest), { recursive: true });
        await cp(join(this.fixture, rel), dest);
      }
      // manifest.json is copied alongside each phase so gates[] and loops advance
      // the way the orchestrator would advance them — the watcher reads it either way.
      await this.syncManifest(inv, group.phase.label);
      await sleep(this.stepMs);
    }

    return { ok: true, finalText: `[stub] replayed ${ordered.length} phase(s) from ${this.fixture}` };
  }

  /** Copy the fixture manifest, keeping this run's own id and paths. */
  private async syncManifest(inv: RunnerInvocation, phase: string): Promise<void> {
    if (!this.fixture) return;
    const src = join(this.fixture, "manifest.json");
    if (!existsSync(src)) return;
    const manifest = JSON.parse(await readFile(src, "utf8")) as Record<string, unknown>;
    manifest.runId = inv.ctx.runId;
    manifest.notes = `[stub replay] ${phase} — replayed from ${this.fixture}. Not a real agent run.`;
    await writeFile(join(inv.ctx.runDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }

  private async note(inv: RunnerInvocation, line: string): Promise<void> {
    await mkdir(inv.ctx.runDir, { recursive: true });
    const log = join(inv.ctx.runDir, "stub-runner.log");
    const prev = existsSync(log) ? await readFile(log, "utf8") : "";
    await writeFile(log, `${prev}${new Date().toISOString()} ${line}\n`);
  }
}
