/**
 * Brief intake — the form is GENERATED from design.surfaces[<id>].briefSchema.
 *
 * Headings appear in schema order (that order is part of the contract), hints are
 * the placeholders, and required headings are marked. Studio never invents a field
 * and never reorders one.
 *
 * Submitting writes the requester's brief and drives `/design <brief-path>`. Gate 1
 * is design-brief-intake's, not Studio's: Studio does not write 01-brief.md, and
 * does not decide whether the brief is complete.
 *
 * When intake comes back BRIEF: BLOCKED, each question renders in its structured
 * shape and the answers are saved VERBATIM to 00-input/answers-<n>.md — which is
 * what the pipeline expects and re-reads.
 */
import { useEffect, useState } from "react";
import type { BriefSchemaResponse, RunDetail, SurfaceSummary } from "@valiify/studio-shared";
import { api } from "../api.ts";
import { Button, Empty, Panel, Tag } from "../components/ui.tsx";
import { ClarificationList } from "../components/Clarification.tsx";

export function BriefIntake({
  surface, onCreated,
}: {
  surface: SurfaceSummary;
  onCreated: (runId: string) => void;
}) {
  const [schema, setSchema] = useState<BriefSchemaResponse | null>(null);
  const [slug, setSlug] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.briefSchema(surface.id).then(setSchema).catch((e) => setError(e.message));
  }, [surface.id]);

  if (error) return <Panel title="Cannot read the brief schema"><p className="text-sm text-blocking">{error}</p></Panel>;
  if (!schema) return <Panel title="Brief"><Empty>Reading design.surfaces.{surface.id}.briefSchema…</Empty></Panel>;

  const missingRequired = schema.fields.filter((f) => f.required && !values[f.heading]?.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.createRun({
        surfaceId: surface.id,
        slug,
        sections: schema!.fields.map((f) => ({ heading: f.heading, body: values[f.heading] ?? "" })),
      });
      onCreated(res.runId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={`Brief — ${schema.displayName ?? schema.surfaceId}`}
        right={<span className="font-mono text-[10px] text-ink-3">{schema.methodologyPath}</span>}
      >
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-wider text-ink-3">SLUG — names the run directory</span>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="primary-contact"
            className="border border-line bg-ground p-2 font-mono text-xs"
          />
        </label>

        <div className="mt-4 flex flex-col gap-4">
          {/* Generated, in schema order. Nothing here is hand-written per surface. */}
          {schema.fields.map((field) => (
            <label key={field.heading} className="flex flex-col gap-1">
              <span className="flex items-center gap-2">
                <span className="text-xs font-semibold text-ink">{field.heading}</span>
                {field.required && <Tag tone="draft">required</Tag>}
              </span>
              <textarea
                value={values[field.heading] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [field.heading]: e.target.value }))}
                rows={field.hint && field.hint.includes("|") ? 4 : 2}
                placeholder={field.hint}
                className="resize-y border border-line bg-ground p-2 font-mono text-xs leading-relaxed"
              />
              {field.hint && <span className="text-[10px] text-ink-3">{field.hint}</span>}
            </label>
          ))}
        </div>
      </Panel>

      {schema.stopTriggers.length > 0 && (
        <Panel title="This surface's stop triggers" right={<span className="font-mono text-[10px] text-ink-3">from design.surfaces</span>}>
          <ul className="flex flex-col gap-2">
            {schema.stopTriggers.map((t) => (
              <li key={t.trigger} className="flex gap-2 text-xs">
                <Tag tone="blocking">{t.trigger}</Tag>
                <span className="text-ink-2">{t.when}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[10px] text-ink-3">
            A brief that trips one of these comes back BLOCKED. That is the pipeline working: intake asks rather
            than guessing, and the run waits for your answer.
          </p>
        </Panel>
      )}

      {error && <p className="border border-blocking bg-blocking/5 p-3 text-sm text-blocking">{error}</p>}

      <div className="flex items-center justify-between gap-4">
        <p className="text-[10px] text-ink-3">
          {missingRequired.length
            ? `${missingRequired.length} required heading(s) empty — intake will raise brief-missing-field.`
            : "All required headings filled."}
        </p>
        <Button kind="primary" onClick={submit} disabled={busy || !slug.trim()}>
          {busy ? "Starting…" : "Submit brief — run /design"}
        </Button>
      </div>
    </div>
  );
}

/** The BRIEF: BLOCKED view. Same component as a refusal, by design. */
export function BlockedBrief({ run, onSubmitted }: { run: RunDetail; onSubmitted: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const round = run.clarifications[0];
  if (!round) return null;

  const blocking = round.questions.filter((q) => q.blocking);
  const answered = blocking.filter((q) => answers[q.id ?? ""]?.trim()).length;

  return (
    <div className="flex flex-col gap-4">
      <ClarificationList
        round={round}
        answers={answers}
        onAnswer={(id, text) => setAnswers((a) => ({ ...a, [id]: text }))}
        heading="BRIEF: BLOCKED — intake is waiting on the requester"
      />
      <div className="flex items-center justify-between gap-4">
        <p className="text-[10px] text-ink-3">
          {answered} of {blocking.length} blocking questions answered. A blocking question is never defaulted —
          answers are written verbatim to 00-input/answers-&lt;n&gt;.md.
        </p>
        <Button
          kind="primary"
          disabled={busy || answered < blocking.length}
          onClick={async () => {
            setBusy(true);
            await api.answers(run.runId, {
              answers: Object.entries(answers).map(([questionId, text]) => ({ questionId, text })),
            });
            setBusy(false);
            onSubmitted();
          }}
        >
          {busy ? "Saving…" : "Save answers"}
        </Button>
      </div>
    </div>
  );
}
