/**
 * Studio's shell.
 *
 * The screen shown for a run is chosen by its STAGE, which is derived from the run
 * directory. So a run that advances because someone ran `/design build` in a
 * terminal moves this UI forward too, with no polling and no special case.
 */
import { useEffect, useState } from "react";
import type { StudioHealth, SurfaceSummary } from "@valiify/studio-shared";
import { api } from "./api.ts";
import { useRunList, useRunStream } from "./useRunStream.ts";
import { Banner, Button, Empty, Panel, Tag, Verbatim } from "./components/ui.tsx";
import { GateRail } from "./components/GateRail.tsx";
import { SurfacePicker } from "./screens/SurfacePicker.tsx";
import { BlockedBrief, BriefIntake } from "./screens/BriefIntake.tsx";
import { ConceptReview } from "./screens/ConceptReview.tsx";
import { Approve } from "./screens/Approve.tsx";
import { Handoff } from "./screens/Handoff.tsx";
import { CommitPanel, RunList } from "./screens/RunList.tsx";

type View = { name: "surfaces" } | { name: "brief"; surface: SurfaceSummary } | { name: "run"; runId: string };

export default function App() {
  const [health, setHealth] = useState<StudioHealth | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ name: "surfaces" });
  const { runs, errors } = useRunList();

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setBootError(e.message));
  }, []);

  if (bootError) {
    return (
      <Shell>
        <Panel title="Studio backend unreachable">
          <p className="text-sm text-blocking">{bootError}</p>
          <p className="mt-2 text-xs text-ink-3">
            Start it with <code className="font-mono">npm run dev:server -- --target '&lt;library repo&gt;'</code>.
          </p>
        </Panel>
      </Shell>
    );
  }
  if (!health) return <Shell><Empty>Connecting…</Empty></Shell>;

  // The preflight is fatal on the backend; if a Studio is running with it disabled,
  // say so here rather than letting a run begin against general-purpose agents.
  if (!health.preflight.ok) {
    return (
      <Shell health={health}>
        <Panel title="Preflight failed — the design pipeline is not registered in the target repo">
          <Verbatim
            text={[
              `target: ${health.preflight.targetRepo}`,
              health.preflight.error ? `error: ${health.preflight.error}` : "",
              `missing subagents: ${health.preflight.missingAgents.join(", ") || "none"}`,
              `missing commands: ${health.preflight.missingCommands.join(", ") || "none"}`,
              health.preflight.libraryMatches === false
                ? `agents were generated for "${health.preflight.agentLibrary}", config says "${health.preflight.configLibrary}"`
                : "",
              "",
              "Without the five design-* subagents and /design, the pipeline degrades to",
              "general-purpose agents — the full tool set and none of the discipline.",
              "",
              `  cd '${health.preflight.targetRepo}' && npx val-init`,
            ].filter(Boolean).join("\n")}
          />
        </Panel>
      </Shell>
    );
  }

  return (
    <Shell health={health}>
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-3">
          <Button onClick={() => setView({ name: "surfaces" })}>+ New run</Button>
          {/* An unreadable runs root is shown here, never as an empty list. */}
          {errors.map((e, i) => <Banner key={i} tone="blocking" title="Cannot read a runs directory">{e}</Banner>)}
          <RunList runs={runs} onOpen={(runId) => setView({ name: "run", runId })} />
        </aside>
        <main className="min-w-0">
          {view.name === "surfaces" && (
            <SurfacePickerScreen onPick={(surface) => setView({ name: "brief", surface })} />
          )}
          {view.name === "brief" && (
            <BriefIntake surface={view.surface} onCreated={(runId) => setView({ name: "run", runId })} />
          )}
          {view.name === "run" && <RunScreen runId={view.runId} />}
        </main>
      </div>
    </Shell>
  );
}

function SurfacePickerScreen({ onPick }: { onPick: (s: SurfaceSummary) => void }) {
  const [target, setTarget] = useState<Awaited<ReturnType<typeof api.target>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Re-read on every visit: a surface added to val/config.json shows up without a restart.
    setError(null);
    api.target().then(setTarget).catch((e: Error) => setError(e.message));
  }, []);
  // A config that cannot be read used to leave this screen on "Reading…" forever.
  if (error) {
    return (
      <Banner tone="blocking" title="Cannot read the target repo's val/config.json">
        {error}
        <p className="mt-2 text-[10px]">
          Studio drives an existing val-inited library repo. Check the <code className="font-mono">--target</code>{" "}
          path, and that <code className="font-mono">val/config.json</code> is present and valid JSON.
        </p>
      </Banner>
    );
  }
  if (!target) return <Empty>Reading val/config.json…</Empty>;
  return <SurfacePicker target={target} onPick={onPick} />;
}

function RunScreen({ runId }: { runId: string }) {
  const { run, connected, progress, transitions, error, lastEventAt } = useRunStream(runId);
  const [refresh, setRefresh] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const bump = () => {
    setActionError(null);
    setRefresh((r) => r + 1);
  };

  if (!run) {
    return (
      <div className="flex flex-col gap-4">
        {/*
          A run Studio dispatched does not exist until Gate 0 creates its directory,
          so "attaching" is normal for a moment. A stream that will not connect is
          not, and used to sit on this line forever.
        */}
        {connected || !error ? <Empty>Attaching to {runId}…</Empty> : null}
        {!connected && (
          <Banner tone="blocking" title={`Cannot attach to "${runId}"`}>
            The run directory is not there yet, or the Studio backend is down. Gate 0 creates the directory —
            until it does, there is nothing to read. {error ?? ""}
          </Banner>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" key={refresh}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-mono text-sm">{run.runId}</h1>
        <div className="flex items-center gap-1.5">
          {run.surface && <Tag>{run.surface}</Tag>}
          {run.readOnly && <Tag tone="draft">read-only reference run</Tag>}
          <Tag tone={connected ? "ok" : "blocking"}>{connected ? "live" : "disconnected"}</Tag>
        </div>
      </div>

      {/*
        Three failures that used to be invisible: a dropped stream (the run stops
        moving and looks slow), a runner that failed (nothing ever appears), and a
        manifest that is on disk but corrupt (which read as "no manifest yet").
      */}
      {!connected && (
        <Banner tone="blocking" title="Live updates are disconnected">
          This screen is showing the last snapshot it received
          {lastEventAt ? ` (${new Date(lastEventAt).toLocaleTimeString()})` : ""}. The run may have advanced since.
          The browser retries on its own; if it does not come back, the Studio backend has stopped.
        </Banner>
      )}
      {error && <Banner tone="blocking" title="The pipeline run failed">{error}</Banner>}
      {actionError && <Banner tone="blocking" title="That action failed">{actionError}</Banner>}
      {run.manifestError && (
        <Banner tone="blocking" title="manifest.json is unreadable">
          {run.manifestError} — the stage below is derived from the files on disk alone, so anything only the
          manifest can express (awaiting-approval, the loop counters, the gate records) is missing.
        </Banner>
      )}
      {run.readError && <Banner tone="blocking" title="Cannot read the run directory">{run.readError}</Banner>}
      {run.readOnly && (
        <Banner tone="draft" title="Reference run — open for reading only">
          This run lives under the target repo's tracked fixtures. Studio refuses every write against it: no
          feedback round, no answers file, no approval, no commit. A fixture is a committed record.
        </Banner>
      )}

      <GateRail stage={run.stage} loops={run.loops} transitions={transitions} />

      {/* Stage picks the screen. The stage came from the run directory. */}
      {run.stage === "blocked-brief" && <BlockedBrief run={run} onSubmitted={bump} onError={setActionError} />}
      {(run.stage === "concept" || run.stage === "critique") && (
        <ConceptReview run={run} onChanged={bump} onError={setActionError} canSendFeedback={!run.readOnly} />
      )}
      {run.stage === "awaiting-approval" && (
        <>
          <ConceptReview run={run} onChanged={bump} onError={setActionError} canSendFeedback={!run.readOnly} />
          <Approve run={run} onApproved={bump} onError={setActionError} />
        </>
      )}
      {(run.stage === "approved" || run.stage === "build") && (
        <Approve run={run} onApproved={bump} onError={setActionError} />
      )}
      {(run.stage === "verified" || run.stage === "signed-off") && (
        <>
          {/* Past the seal the concept is still the thing the package was built from,
              so it stays readable — with no round on offer, because there is no gate
              left to accept one. */}
          <ConceptReview run={run} onChanged={bump} onError={setActionError} canSendFeedback={false} />
          <Approve run={run} onApproved={bump} onError={setActionError} />
          <Handoff run={run} />
          <CommitPanel
            git={run.git}
            readOnly={run.readOnly}
            onCommit={(message) =>
              void api.commit(run.runId, message).then((r) => {
                // A refusal is an answer the reviewer has to see, not a no-op.
                if (r.committed) bump();
                else setActionError(r.refusedReason ?? "The commit was refused with no reason given.");
              })
            }
          />
        </>
      )}
      {run.stage === "intake" && <Empty>Intake is running — 01-brief.md has not appeared yet.</Empty>}
      {run.stage === "needs-human-review" && (
        <Panel title="Needs human review">
          <p className="text-sm text-ink-2">
            The run stopped because a loop hit its cap. The cap is not raisable from here.
          </p>
          {run.manifest?.notes && <p className="mt-2 text-xs text-ink-3">{run.manifest.notes}</p>}
        </Panel>
      )}

      {progress.length > 0 && (
        <Panel title="Agent progress" right={<span className="font-mono text-[10px] text-ink-3">advisory — not a stage record</span>}>
          <ul className="flex flex-col gap-0.5 font-mono text-[10px] text-ink-3">
            {progress.slice(-12).map((p, i) => (
              <li key={i}>{p.agent ? `${p.agent} · ` : ""}{p.text}</li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function Shell({ children, health }: { children: React.ReactNode; health?: StudioHealth }) {
  return (
    <div className="mx-auto flex min-h-full max-w-[1400px] flex-col gap-4 p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-3">
        <h1 className="text-sm font-semibold tracking-[0.08em] uppercase">Valiify Studio</h1>
        {health && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Tag>{health.target.library.displayName ?? health.target.library.name}</Tag>
            <Tag tone={health.runner === "stub" ? "draft" : "neutral"}>runner: {health.runner}</Tag>
            <Tag tone={health.preflight.ok ? "ok" : "blocking"}>
              preflight {health.preflight.ok ? "ok" : "failed"}
            </Tag>
          </div>
        )}
      </header>
      {children}
    </div>
  );
}
