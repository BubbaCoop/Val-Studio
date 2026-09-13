/**
 * The run list.
 *
 * Every run under the configured runOutputDir, whoever started it. A run driven from
 * the CLI appears here with the same stage, the same loop counters and the same
 * live updates as one started in Studio — because both are read from the run
 * directory, and neither is read from an agent stream.
 */
import type { RunSummary } from "@valiify/studio-shared";
import { Empty, Panel, Tag } from "../components/ui.tsx";

const TONE: Record<string, "neutral" | "blocking" | "draft" | "ok"> = {
  "signed-off": "ok",
  verified: "ok",
  "blocked-brief": "blocking",
  "needs-human-review": "blocking",
  "awaiting-approval": "draft",
};

export function RunList({ runs, onOpen }: { runs: RunSummary[]; onOpen: (runId: string) => void }) {
  return (
    <Panel title="Runs" right={<span className="font-mono text-[10px] text-ink-3">{runs.length}</span>}>
      {runs.length === 0 ? (
        <Empty>No runs yet.</Empty>
      ) : (
        <ul className="flex flex-col">
          {runs.map((r) => (
            <li key={r.runId}>
              <button
                onClick={() => onOpen(r.runId)}
                className="flex w-full flex-col gap-1.5 border-b border-line/60 px-1 py-2 text-left hover:bg-ground"
              >
                {/* The directory name is the run's identity, so it gets its own line
                    and wraps rather than collapsing behind the status tags. */}
                <span className="font-mono text-[11px] leading-tight break-all">{r.runId}</span>
                <span className="flex flex-wrap items-center gap-1">
                  {r.surface && <Tag>{r.surface}</Tag>}
                  <Tag tone={TONE[r.stage] ?? "neutral"}>{r.stage}</Tag>
                  <Tag>v{r.conceptVersions}</Tag>
                  {r.loops.feedback > 0 && <Tag>{r.loops.feedback} feedback</Tag>}
                  {r.stale && <Tag tone="draft">stale</Tag>}
                  {r.root === "fixtures" && <Tag tone="draft">reference</Tag>}
                  {r.manifestMissing && <Tag tone="draft">no manifest</Tag>}
                  {r.manifestError && <Tag tone="blocking">manifest unreadable</Tag>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * The commit action — explicit, and offered at signed-off only.
 *
 * The backend does not commit automatically: an agent pipeline writing dozens of
 * files should not also produce commits nobody asked for. At an intermediate gate
 * this panel says why it is withholding rather than hiding the state.
 */
export function CommitPanel({
  git, onCommit, readOnly = false,
}: {
  git: RunSummaryGit;
  onCommit: (message?: string) => void;
  /** A reference run is never committed from here — it is already committed. */
  readOnly?: boolean;
}) {
  if (!git.isRepo) return null;
  return (
    <Panel
      title="Git"
      right={
        <span className="flex items-center gap-1.5">
          {git.branch && <Tag>{git.branch}</Tag>}
          <Tag tone={git.hasUncommittedChanges ? "draft" : "ok"}>
            {git.hasUncommittedChanges ? `${git.dirtyPaths.length} uncommitted` : "clean"}
          </Tag>
        </span>
      }
    >
      {git.lastCommit && (
        <p className="font-mono text-[10px] text-ink-3">
          last: {git.lastCommit.sha} {git.lastCommit.subject}
        </p>
      )}
      {readOnly ? (
        <p className="mt-3 border-l-2 border-line pl-2 text-xs text-ink-3">
          This is a read-only reference run. It is already part of the target repo's history; Studio does not
          commit into it.
        </p>
      ) : git.ignoredByGit ? (
        /*
         * The common case, and the one that used to ship as a dead button: the runs
         * directory is excluded by .gitignore, so git never sees the run as changed.
         * Say so, name the rule, and point at the path that does work.
         */
        <div className="mt-3 border-l-2 border-draft bg-draft/5 p-2">
          <p className="text-xs text-ink-2">{git.commitWithheldReason}</p>
          {git.ignoreRule && (
            <p className="mt-1 font-mono text-[10px] text-ink-3">git check-ignore: {git.ignoreRule}</p>
          )}
        </div>
      ) : git.commitOffered ? (
        <div className="mt-3">
          <p className="text-xs text-ink-2">
            This run is signed off: the directory holds the sealed approval and the verified package, and is worth
            a durable record.
          </p>
          <button
            onClick={() => onCommit()}
            className="mt-2 border border-ink bg-ink px-3 py-1.5 text-sm text-white"
          >
            Commit this run
          </button>
        </div>
      ) : git.commitWithheldReason ? (
        <p className="mt-3 border-l-2 border-line pl-2 text-xs text-ink-3">{git.commitWithheldReason}</p>
      ) : null}
    </Panel>
  );
}

type RunSummaryGit = import("@valiify/studio-shared").GitState;
