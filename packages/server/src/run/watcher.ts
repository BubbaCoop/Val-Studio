/**
 * The run directory watcher — Studio's ONLY source of truth about run progress.
 *
 * It watches for file appearance (01-brief.md, 02-concept/concept.v<n>.html,
 * 03-critique-<n>.md, 04-approval.md, 05-package/) and for manifest.json changes
 * (status, gates[], loops), and relays both as gate transitions.
 *
 * Nothing here reads an agent stream. That is the point: a run driven from the CLI
 * produces exactly the same events as one driven from Studio, because both write the
 * same files. Agent stream events are wired separately and carry token-level
 * progress only — they never decide what stage a run is in.
 */
import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";
import type { Manifest, RunEvent, RunStage } from "@valiify/studio-shared";
import { readRunDetail } from "./reader.ts";
import { RUN_FILES, classify, walk } from "./paths.ts";
import type { RunRoot } from "./roots.ts";

/** fs events arrive in bursts while an agent writes; coalesce before re-reading. */
const DEBOUNCE_MS = 120;

interface Snapshot {
  files: Set<string>;
  stage: RunStage;
  status: string;
  gateCount: number;
  loops: string;
}

export type Emit = (event: RunEvent) => void;

export class RunWatcher {
  repo: string;
  runDir: string;
  runId: string;
  emit: Emit;
  private root: RunRoot | undefined;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private snapshot: Snapshot | null = null;
  private scanning = false;
  private rescanQueued = false;

  constructor(repo: string, runDir: string, runId: string, emit: Emit, root?: RunRoot) {
    this.repo = repo;
    this.runDir = runDir;
    this.runId = runId;
    this.emit = emit;
    this.root = root;
  }

  async start(): Promise<void> {
    await this.scan(true);
    try {
      this.watcher = watch(this.runDir, { recursive: true }, () => this.schedule());
    } catch (err) {
      // Recursive watching is unavailable on some platforms; a slow poll still
      // keeps the run observable rather than silently reporting a frozen gate. Say so
      // — an unannounced downgrade to polling looks exactly like a slow pipeline.
      console.warn(
        `[studio] cannot watch ${this.runDir} (${(err as Error).message}); polling every 2s instead.`,
      );
      const poll = setInterval(() => this.schedule(), 2000);
      this.watcher = { close: () => clearInterval(poll) } as unknown as FSWatcher;
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.scan(false), DEBOUNCE_MS);
  }

  /** Re-read the directory, diff against the last snapshot, emit what changed. */
  private async scan(initial: boolean): Promise<void> {
    if (this.scanning) {
      this.rescanQueued = true;
      return;
    }
    this.scanning = true;
    try {
      const detail = await readRunDetail(this.repo, this.runDir, this.root);
      const files = new Set(await walk(this.runDir));
      const at = new Date().toISOString();
      const manifest = detail.manifest as Manifest | null;
      const next: Snapshot = {
        files,
        stage: detail.stage,
        status: String(detail.status),
        gateCount: detail.gates.length,
        loops: JSON.stringify(detail.loops),
      };

      if (initial || !this.snapshot) {
        this.snapshot = next;
        this.emit({ type: "snapshot", runId: this.runId, at, run: detail });
        return;
      }
      const prev = this.snapshot;

      for (const f of files) {
        if (!prev.files.has(f)) {
          this.emit({ type: "file", runId: this.runId, at, change: "added", path: f, artefact: classify(f) });
        }
      }
      for (const f of prev.files) {
        if (!files.has(f)) {
          this.emit({ type: "file", runId: this.runId, at, change: "removed", path: f, artefact: classify(f) });
        }
      }

      const manifestChanged =
        next.status !== prev.status || next.gateCount !== prev.gateCount || next.loops !== prev.loops;
      if (manifestChanged) {
        this.emit({
          type: "manifest",
          runId: this.runId,
          at,
          status: detail.status,
          stage: detail.stage,
          loops: detail.loops,
          newGates: detail.gates.slice(prev.gateCount).map((g) => ({
            gate: g.gate,
            agent: g.agent,
            status: String(g.status),
            at: g.at,
          })),
        });
      }

      if (next.stage !== prev.stage) {
        this.emit({
          type: "stage",
          runId: this.runId,
          at,
          from: prev.stage,
          to: next.stage,
          because: stageEvidence(detail.stage, files, manifest),
        });
        // A stage change is where a screen navigates, so resend the full detail
        // rather than making the client reconcile a transition from fragments.
        this.emit({ type: "snapshot", runId: this.runId, at, run: detail });
      } else if (manifestChanged || next.files.size !== prev.files.size) {
        this.emit({ type: "snapshot", runId: this.runId, at, run: detail });
      }

      this.snapshot = next;
    } catch (err) {
      // A scan that dies takes the run's live updates with it, and the client sees a
      // gate that never moves. Report it and keep the watcher alive.
      console.error(`[studio] scan of ${this.runDir} failed: ${(err as Error).message}`);
      this.emit({
        type: "lifecycle",
        runId: this.runId,
        at: new Date().toISOString(),
        phase: "failed",
        error: `Studio could not read this run directory: ${(err as Error).message}`,
      });
    } finally {
      this.scanning = false;
      if (this.rescanQueued) {
        this.rescanQueued = false;
        this.schedule();
      }
    }
  }
}

/** Name the file or manifest field that produced a transition — evidence, not inference. */
function stageEvidence(stage: RunStage, files: Set<string>, manifest: Manifest | null): string {
  const has = (p: string) => files.has(p) || [...files].some((f) => f.startsWith(p + sep) || f.startsWith(p + "/"));
  switch (stage) {
    case "intake":
      return `${RUN_FILES.brief} appeared`;
    case "blocked-brief":
      return `${RUN_FILES.brief} carries BLOCKING open questions`;
    case "concept": {
      const latest = [...files].filter((f) => f.startsWith("02-concept/concept.v")).sort().at(-1);
      return `${latest ?? "a concept version"} appeared`;
    }
    case "critique": {
      const latest = [...files].filter((f) => /^03-critique-\d+\.md$/.test(f)).sort().at(-1);
      return `${latest ?? "a critique"} appeared`;
    }
    case "awaiting-approval":
      return "manifest.status became awaiting-approval";
    case "approved":
      return `${RUN_FILES.approval} appeared (sealed by /design build)`;
    case "build":
      return has(RUN_FILES.packageDir) ? "05-package/ appeared" : "build started";
    case "verified":
      return "a 06-verify-<n>.md reported VERIFY: PASS";
    case "signed-off":
      return files.has(RUN_FILES.writeup) ? "07-writeup.md appeared" : "manifest.status became signed-off";
    case "needs-human-review":
      return `manifest.status became needs-human-review${manifest?.loops?.critic ? ` after ${manifest.loops.critic} critic loops` : ""}`;
    default:
      return "run directory created";
  }
}

/**
 * Watches every runs root so the run LIST stays live — a run created by the CLI
 * appears in Studio without a refresh.
 *
 * A root that cannot be watched is announced, not silently downgraded: a root that is
 * simply not on disk, and one that Studio quietly stopped watching, look identical
 * from the UI and only one of them is fixable.
 */
export class RunsRootWatcher {
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  /** Roots are resolved from val/config.json, so starting is async. */
  async start(roots: RunRoot[]): Promise<void> {
    const fire = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(this.onChange, 250);
    };
    for (const root of roots) {
      if (!root.exists) {
        if (root.id === "runs") {
          console.error(
            `[studio] ${root.relDir}/ does not exist — the run list will stay empty until the pipeline creates it.`,
          );
        }
        continue;
      }
      try {
        this.watchers.push(watch(root.dir, { recursive: true }, fire));
      } catch (err) {
        console.warn(`[studio] cannot watch ${root.relDir}/ (${(err as Error).message}); polling every 4s instead.`);
        if (!this.polling) {
          this.polling = true;
          const poll = setInterval(this.onChange, 4000);
          this.watchers.push({ close: () => clearInterval(poll) } as unknown as FSWatcher);
        }
      }
    }
    this.onChange();
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearTimeout(this.timer);
  }
}
