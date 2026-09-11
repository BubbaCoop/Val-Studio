/**
 * Concept review — Gate 4, the human gate.
 *
 * Renders concept.v<n>.html with concept.css and overlays hotspots keyed by
 * data-block. Selecting a block composes a critique finding; the collected rows
 * become 00-input/feedback-<n>.md.
 *
 * The pin is the load-bearing detail. The round is written from THE CONCEPT THAT IS
 * RENDERED HERE — `viewing` — never from "the latest". Block ids are stable across
 * versions, so an unpinned round collected on v2 would apply cleanly to v3 with
 * nothing to show it had happened.
 *
 * When the validator rejects the round for a stale pin, the correct UI response is
 * to RE-RENDER the current concept and ask the designer to re-confirm — never to
 * remap their findings onto a drawing they did not look at. That is what
 * `staleConceptPin` drives below.
 */
import { useMemo, useState } from "react";
import type { ConceptDoc, FeedbackFinding, RunDetail, SubmitFeedbackResponse } from "@valiify/studio-shared";
import { api } from "../api.ts";
import { Button, Empty, Panel, Tag, Verbatim } from "../components/ui.tsx";
import { ConceptFrame } from "../components/ConceptFrame.tsx";
import { FindingComposer, FindingRows } from "../components/FindingComposer.tsx";
import { ClarificationList } from "../components/Clarification.tsx";

export function ConceptReview({
  run, onChanged, onError, canSendFeedback = true,
}: {
  run: RunDetail;
  onChanged: () => void;
  onError?: (message: string) => void;
  /**
   * A Gate 4a round re-enters Gate 2, so it is only legal while the run is still at
   * the concept, critique or human gate. Past the seal — and on a read-only reference
   * run — the concept is still worth reading, and Studio must not offer a round the
   * pipeline would have no gate to accept.
   */
  canSendFeedback?: boolean;
}) {
  const latest = run.concepts.at(-1);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [concept, setConcept] = useState<ConceptDoc | null>(run.latestConcept);
  const [selected, setSelected] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [findings, setFindings] = useState<FeedbackFinding[]>([]);
  const [result, setResult] = useState<SubmitFeedbackResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const viewing = viewingVersion ?? latest?.version ?? null;
  const viewingFile = run.concepts.find((c) => c.version === viewing)?.fileName ?? "";
  const isLatest = viewing === latest?.version;

  // The concept whose ids the composer offers. It must be the one on screen.
  const doc = useMemo(
    () => (viewing === run.latestConcept?.version ? run.latestConcept : concept),
    [viewing, run.latestConcept, concept],
  );

  const draftCopy = run.copy.filter((c) => c.source === "DRAFT");
  const lastCritique = run.critiques.at(-1);
  const refusals = run.clarifications.filter((c) => c.origin === "feedback");

  if (!latest) return <Panel title="Concept"><Empty>No concept drawn yet.</Empty></Panel>;

  async function send(dryRun: boolean) {
    if (!viewingFile) return;
    setBusy(true);
    try {
      const res = await api.feedback(run.runId, {
        // Pinned to what is on screen, always.
        concept: viewingFile,
        findings,
        dryRun,
      });
      setResult(res);
      if (res.accepted) {
        setFindings([]);
        onChanged();
      }
    } catch (e) {
      // A transport or refusal error is not a validator verdict, and must not be
      // rendered as one — the round was never validated at all.
      onError?.((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {refusals.map((r, i) => (
        /* A refusal is rendered with the SAME component as a blocked brief. */
        <ClarificationList key={i} round={r} heading="This ask is not determined by the methodology" />
      ))}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-3">
          <Panel
            title={`Concept ${viewingFile}`}
            right={
              <div className="flex items-center gap-2">
                {run.concepts.map((c) => (
                  <button
                    key={c.version}
                    onClick={() => {
                      setViewingVersion(c.version);
                      setSelected(null);
                      setResult(null);
                      // The composer offers ids from THIS version. A failure here
                      // would leave it offering the previous version's ids, so it is
                      // reported rather than swallowed.
                      void api
                        .conceptBlocks(run.runId, c.version)
                        .then(setConcept)
                        .catch((e: Error) => onError?.(`Cannot read concept v${c.version}: ${e.message}`));
                    }}
                    className={`border px-2 py-0.5 font-mono text-[10px] ${
                      c.version === viewing ? "border-ink bg-ink text-white" : "border-line bg-ground text-ink-2"
                    }`}
                  >
                    v{c.version}
                  </button>
                ))}
              </div>
            }
          >
            {!isLatest && (
              <p className="mb-2 border-l-2 border-blocking bg-blocking/5 p-2 text-xs text-blocking">
                You are looking at v{viewing}, which has been superseded by v{latest.version}. A round pinned to a
                superseded version is rejected — switch to v{latest.version} before composing findings.
              </p>
            )}
            <ConceptFrame
              src={api.conceptUrl(run.runId, viewing!)}
              blocks={doc?.blocks ?? []}
              selectedId={selected}
              onSelect={(id) => {
                setSelected(id);
                if (canSendFeedback) setComposing(true);
              }}
              version={viewing!}
            />
          </Panel>

          {canSendFeedback && composing && doc && (
            <FindingComposer
              concept={doc}
              seedBlock={selected}
              onCancel={() => setComposing(false)}
              onAdd={(f) =>
                // Ids are H1, H2 … — H for human; the critic uses F.
                setFindings((rows) => [...rows, { ...f, id: `H${rows.length + 1}` }])
              }
            />
          )}
        </div>

        <div className="flex flex-col gap-3">
          <Panel
            title="Critic loop"
            right={<Tag tone={run.loops.critic >= run.loops.criticCap ? "blocking" : "neutral"}>{run.loops.critic} / {run.loops.criticCap}</Tag>}
          >
            {lastCritique ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Tag tone={lastCritique.verdict === "PASS" ? "ok" : "blocking"}>CRITIQUE: {lastCritique.verdict}</Tag>
                  <span className="font-mono text-[10px] text-ink-3">
                    {lastCritique.findings} findings · {lastCritique.blocking} blocking
                  </span>
                </div>
                <p className="text-[10px] text-ink-3">
                  The cap is 3 and is not raisable here. A critic that cannot converge in three passes is a defect,
                  and the run goes to needs-human-review.
                </p>
              </div>
            ) : (
              <Empty>No critique yet.</Empty>
            )}
          </Panel>

          <Panel
            title="DRAFT copy"
            right={<Tag tone={draftCopy.length ? "draft" : "neutral"}>{draftCopy.length}</Tag>}
          >
            {draftCopy.length === 0 ? (
              <Empty>No drafted copy — every string came from the brief.</Empty>
            ) : (
              <ul className="flex flex-col gap-2">
                {draftCopy.map((c) => (
                  <li key={c.id} className="border-l-2 border-draft bg-draft/5 p-2">
                    <div className="flex items-center gap-2">
                      <Tag tone="draft">{c.id}</Tag>
                      <span className="font-mono text-[10px] text-ink-3">{c.role}</span>
                    </div>
                    <p className="mt-1 text-xs text-ink">{c.text}</p>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[10px] text-ink-3">
              Approving the concept approves this copy. Legal and consent text is never drafted.
            </p>
          </Panel>

          <Panel
            title="Feedback round"
            right={<span className="font-mono text-[10px] text-ink-3">round {run.loops.feedback + 1} · uncapped</span>}
          >
            {!canSendFeedback ? (
              <p className="text-xs text-ink-3">
                {run.readOnly
                  ? "This is a read-only reference run — it takes no feedback rounds."
                  : `A feedback round re-enters Gate 2, so it is offered at the concept, critique and human gates. This run is at "${run.stage}".`}
              </p>
            ) : findings.length === 0 ? (
              <Empty>Select a block in the concept to compose a finding.</Empty>
            ) : (
              <>
                <p className="mb-2 font-mono text-[10px] text-ink-3">Concept: {viewingFile}</p>
                <FindingRows
                  findings={findings}
                  onRemove={(id) =>
                    setFindings((rows) => rows.filter((r) => r.id !== id).map((r, i) => ({ ...r, id: `H${i + 1}` })))
                  }
                />
                <div className="mt-3 flex justify-end gap-2">
                  <Button onClick={() => void send(true)} disabled={busy || run.readOnly}>Validate only</Button>
                  <Button
                    kind="primary"
                    onClick={() => void send(false)}
                    disabled={busy || !isLatest || run.readOnly}
                    title={run.readOnly ? "A reference run takes no feedback rounds" : undefined}
                  >
                    {busy ? "Validating…" : "Send round"}
                  </Button>
                </div>
              </>
            )}

            {result && <ValidationReport result={result} onRerender={() => { setViewingVersion(null); onChanged(); }} />}
          </Panel>
        </div>
      </div>
    </div>
  );
}

/**
 * The validator's own failures, surfaced instead of sending a round the pipeline
 * would reject. A stale pin gets its own treatment, because it has its own answer.
 */
function ValidationReport({ result, onRerender }: { result: SubmitFeedbackResponse; onRerender: () => void }) {
  const report = result.validation.report;
  const fails = report?.findings.filter((f) => f.severity === "fail") ?? [];

  if (result.validation.staleConceptPin) {
    return (
      <div className="mt-3 border border-blocking bg-blocking/5 p-3">
        <p className="text-xs font-semibold text-blocking">The concept moved while you were reviewing it.</p>
        <p className="mt-1 text-xs text-ink-2">
          Your round pins {report?.pinnedConcept}, and {report?.latestConcept} now exists. Block ids are stable
          across versions, so applying these findings now would silently attach them to a drawing you did not look
          at. Re-render the current concept and confirm your findings against it.
        </p>
        <div className="mt-2">
          <Button kind="danger" onClick={onRerender}>Re-render the current concept</Button>
        </div>
      </div>
    );
  }

  return (
    <div className={`mt-3 border p-3 ${report?.verdict === "PASS" ? "border-ok bg-ok/5" : "border-blocking bg-blocking/5"}`}>
      <div className="flex items-center gap-2">
        <Tag tone={report?.verdict === "PASS" ? "ok" : "blocking"}>FEEDBACK-CHECK: {report?.verdict ?? "ERROR"}</Tag>
        {report && (
          <span className="font-mono text-[10px] text-ink-3">
            {report.counts.findings} findings · {report.counts.blocking} blocking
          </span>
        )}
      </div>
      {fails.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {fails.map((f, i) => (
            <li key={i} className="text-xs">
              <span className="font-mono text-[10px] text-blocking">{f.check}</span> {f.message}
              {f.detail && <p className="mt-0.5 text-[10px] text-ink-3">{f.detail}</p>}
            </li>
          ))}
        </ul>
      )}
      {!report && <Verbatim text={result.validation.stdout || result.validation.stderr} />}
    </div>
  );
}
