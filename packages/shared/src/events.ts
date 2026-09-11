/**
 * The SSE channel.
 *
 * Everything that reports WHERE A RUN IS comes from the run directory watcher:
 * file appearance and manifest.json changes, relayed as gate transitions. The
 * `agent-progress` event is the ONLY one sourced from the Agent SDK stream, and it
 * carries token-level progress only — it is never the record of a run's stage.
 *
 * The practical test: a run driven from the CLI emits every event below except
 * `agent-progress`, and is fully observable in Studio without it.
 */
import type { RunStage } from "./run.ts";
import type { RunSummary, RunDetail, LoopState } from "./run.ts";
import type { RunStatus } from "./manifest.ts";

/** Sent once when a client attaches, so it never has to poll for initial state. */
export interface RunSnapshotEvent {
  type: "snapshot";
  runId: string;
  at: string;
  run: RunDetail;
}

/** A watched file appeared, changed or was removed inside the run directory. */
export interface RunFileEvent {
  type: "file";
  runId: string;
  at: string;
  change: "added" | "changed" | "removed";
  /** Run-relative path, e.g. `02-concept/concept.v2.html`. */
  path: string;
  /** Which artefact class this path belongs to, when Studio recognises it. */
  artefact?:
    | "brief" | "answers" | "feedback" | "concept" | "concept-md" | "fix-ledger"
    | "critique" | "approval" | "package" | "contract" | "verify" | "writeup"
    | "manifest" | "check-report";
}

/** manifest.json changed. The authoritative record of gates, loops and status. */
export interface RunManifestEvent {
  type: "manifest";
  runId: string;
  at: string;
  status: RunStatus;
  stage: RunStage;
  loops: LoopState;
  /** Gate records appended since the last event. */
  newGates: { gate: number | string; agent: string; status: string; at: string }[];
}

/** The derived stage moved. This is the gate transition the UI navigates on. */
export interface RunStageEvent {
  type: "stage";
  runId: string;
  at: string;
  from: RunStage;
  to: RunStage;
  /** What on disk caused the transition — the evidence, not a guess. */
  because: string;
}

/**
 * Token-level progress from the Agent SDK stream. Advisory only.
 * Absent entirely for a CLI-driven run, which must still be fully observable.
 */
export interface AgentProgressEvent {
  type: "agent-progress";
  runId: string;
  at: string;
  /** The subagent currently producing output, when the stream names one. */
  agent?: string;
  /** Short human text for a progress line. Never parsed for state. */
  text?: string;
  tokens?: { input?: number; output?: number };
}

/** The runner finished, failed, or was stopped. */
export interface RunLifecycleEvent {
  type: "lifecycle";
  runId: string;
  at: string;
  phase: "started" | "finished" | "failed" | "stopped";
  command?: string;
  error?: string;
}

/** Keeps intermediaries from closing an idle stream. */
export interface HeartbeatEvent {
  type: "heartbeat";
  at: string;
}

export type RunEvent =
  | RunSnapshotEvent
  | RunFileEvent
  | RunManifestEvent
  | RunStageEvent
  | AgentProgressEvent
  | RunLifecycleEvent
  | HeartbeatEvent;

/** The global channel: run list changes, so the index does not poll. */
export interface RunListEvent {
  type: "runs";
  at: string;
  runs: RunSummary[];
}

export type StudioEvent = RunEvent | RunListEvent;
