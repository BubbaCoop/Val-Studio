/**
 * Subscribing to a run over SSE.
 *
 * The stream carries a full `snapshot` on attach and after every stage change, so a
 * screen never polls and never reconciles a transition from fragments. Everything
 * except `agent-progress` originates in the run directory — which is why a run
 * someone started from the CLI shows up here, live, with no difference.
 */
import { useEffect, useRef, useState } from "react";
import type { RunDetail, RunEvent, RunStage, RunSummary } from "@valiify/studio-shared";
import { api } from "./api.ts";

export interface RunStream {
  run: RunDetail | null;
  connected: boolean;
  /** Token-level progress, newest last. Advisory: never the record of a stage. */
  progress: { at: string; agent?: string; text?: string }[];
  /** Gate transitions, with the file evidence that produced each one. */
  transitions: { at: string; from: RunStage; to: RunStage; because: string }[];
  /** A failed run, or a watcher that could not read the run directory. Rendered. */
  error: string | null;
  /** When the stream last delivered anything. A stale stream is a visible state. */
  lastEventAt: string | null;
}

export function useRunStream(runId: string | null): RunStream {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [connected, setConnected] = useState(false);
  const [progress, setProgress] = useState<RunStream["progress"]>([]);
  const [transitions, setTransitions] = useState<RunStream["transitions"]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const idRef = useRef(runId);

  useEffect(() => {
    if (idRef.current !== runId) {
      idRef.current = runId;
      setRun(null);
      setProgress([]);
      setTransitions([]);
      setError(null);
      setLastEventAt(null);
    }
    if (!runId) return;

    const es = new EventSource(api.runEventsUrl(runId));
    const onMessage = (e: MessageEvent) => {
      const event = JSON.parse(e.data) as RunEvent;
      setLastEventAt(new Date().toISOString());
      switch (event.type) {
        case "snapshot":
          setRun(event.run);
          setError(null);
          break;
        case "stage":
          setTransitions((t) => [...t, { at: event.at, from: event.from, to: event.to, because: event.because }]);
          break;
        case "agent-progress":
          setProgress((p) => [...p.slice(-50), { at: event.at, agent: event.agent, text: event.text }]);
          break;
        case "lifecycle":
          if (event.phase === "failed" && event.error) setError(event.error);
          break;
      }
    };

    for (const type of ["snapshot", "file", "manifest", "stage", "agent-progress", "lifecycle", "heartbeat"]) {
      es.addEventListener(type, onMessage as EventListener);
    }
    es.onopen = () => {
      setConnected(true);
      setLastEventAt(new Date().toISOString());
    };
    // EventSource retries on its own, so an error is not fatal — but a run whose
    // stream is down stops moving, and that must not look like a pipeline that is
    // simply taking its time.
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [runId]);

  return { run, connected, progress, transitions, error, lastEventAt };
}

/**
 * The run list, kept live by the global channel so a CLI-created run just appears.
 *
 * `errors` carries roots the backend could not read. An unreadable runs directory and
 * an empty one produce the same list, and only one of them is something the user can
 * fix — so the list never renders "no runs yet" over a read failure.
 */
export function useRunList(): { runs: RunSummary[]; errors: string[]; refresh: () => void } {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  const refresh = () =>
    void api
      .runs()
      .then((r) => {
        setRuns(r.runs);
        setErrors(r.errors ?? []);
      })
      .catch((e: Error) => setErrors([`Cannot reach the Studio backend: ${e.message}`]));

  useEffect(() => {
    refresh();
    const es = new EventSource(api.eventsUrl());
    es.addEventListener("runs", ((e: MessageEvent) => {
      const payload = JSON.parse(e.data) as { runs: RunSummary[]; errors?: string[] };
      setRuns(payload.runs);
      setErrors(payload.errors ?? []);
    }) as EventListener);
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { runs, errors, refresh };
}
