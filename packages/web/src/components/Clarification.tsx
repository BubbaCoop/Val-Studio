/**
 * The clarification card — one component, two callers, on purpose.
 *
 * A BRIEF: BLOCKED question and a refused feedback finding arrive in the SAME
 * structured shape, and the methodology says so deliberately. Rendering them with
 * one component is how Studio keeps the promise: the designer learns the shape once.
 *
 * Every field is rendered AS GIVEN. Nothing here paraphrases, softens, truncates, or
 * collapses a refusal into "not supported". ROUTE: is rendered most prominently of
 * all, because it is the only part that tells the designer how to make the ask legal
 * — drop it and a route becomes a bare refusal, which the methodology forbids.
 */
import { useState } from "react";
import type { ClarificationQuestion, ClarificationRound } from "@valiify/studio-shared";
import { Panel, Tag, Verbatim } from "./ui.tsx";

const FIELDS: { key: keyof ClarificationQuestion; label: string; hint: string }[] = [
  { key: "trigger", label: "TRIGGER", hint: "which stop trigger fired" },
  { key: "neededFor", label: "NEEDED-FOR", hint: "the block, field or step this blocks" },
  { key: "checked", label: "CHECKED", hint: "what was read before asking" },
  { key: "costOfGuessing", label: "COST-OF-GUESSING", hint: "what a wrong default breaks" },
  { key: "acceptableAnswer", label: "ACCEPTABLE-ANSWER", hint: "what would unblock this" },
];

export function ClarificationCard({
  question, answer, onAnswer,
}: {
  question: ClarificationQuestion;
  answer?: string;
  onAnswer?: (text: string) => void;
}) {
  const [raw, setRaw] = useState(false);
  const isRefusal = !!question.route;

  return (
    <article className={`border ${question.blocking ? "border-blocking/50" : "border-line"} bg-panel`}>
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <div className="flex items-center gap-2">
          <Tag tone={question.blocking ? "blocking" : "draft"}>{question.id ?? "Q"}</Tag>
          <Tag tone={question.blocking ? "blocking" : "neutral"}>{question.blocking ? "BLOCKING" : "NON-BLOCKING"}</Tag>
          {isRefusal && <Tag tone="blocking">ROUTE REQUIRED</Tag>}
        </div>
        <button className="font-mono text-[10px] text-ink-3 underline" onClick={() => setRaw((r) => !r)}>
          {raw ? "structured" : "raw"}
        </button>
      </header>

      {raw ? (
        <div className="p-4">
          {/* The unparsed block, exactly as the pipeline wrote it. */}
          <Verbatim text={question.raw} />
        </div>
      ) : (
        <dl className="divide-y divide-line">
          <div className="px-4 py-3">
            <dt className="font-mono text-[10px] tracking-wider text-ink-3">Q</dt>
            <dd className="mt-1 text-sm whitespace-pre-wrap text-ink">{question.question}</dd>
          </div>
          {FIELDS.map(({ key, label, hint }) => {
            const value = question[key] as string | undefined;
            if (!value) return null;
            return (
              <div key={label} className="px-4 py-3">
                <dt className="font-mono text-[10px] tracking-wider text-ink-3" title={hint}>{label}</dt>
                <dd className="mt-1 text-sm whitespace-pre-wrap text-ink-2">{value}</dd>
              </div>
            );
          })}
          {question.route && (
            /*
             * The route. Emphasised because the designer's next step is a real
             * choice — drop the ask, accept a composition the methodology does
             * determine, or get the methodology changed — and this is the only
             * line that tells them how.
             */
            <div className="border-l-2 border-blocking bg-blocking/5 px-4 py-3">
              <dt className="font-mono text-[10px] tracking-wider text-blocking">ROUTE</dt>
              <dd className="mt-1 text-sm whitespace-pre-wrap text-ink">{question.route}</dd>
            </div>
          )}
          {question.proposedDefault && (
            <div className="px-4 py-3">
              <dt className="font-mono text-[10px] tracking-wider text-draft">PROPOSED DEFAULT</dt>
              <dd className="mt-1 text-sm text-ink-2">{question.proposedDefault}</dd>
            </div>
          )}
        </dl>
      )}

      {onAnswer && (
        <div className="border-t border-line p-4">
          <label className="font-mono text-[10px] tracking-wider text-ink-3">
            YOUR ANSWER — saved verbatim to 00-input/answers-&lt;n&gt;.md
          </label>
          <textarea
            value={answer ?? ""}
            onChange={(e) => onAnswer(e.target.value)}
            rows={3}
            placeholder={question.acceptableAnswer ?? "a sentence, a decision, or “out of scope”"}
            className="mt-2 w-full resize-y border border-line bg-ground p-2 font-mono text-xs text-ink outline-none focus:border-ink-2"
          />
        </div>
      )}
    </article>
  );
}

export function ClarificationList({
  round, answers, onAnswer, heading,
}: {
  round: ClarificationRound;
  answers?: Record<string, string>;
  onAnswer?: (id: string, text: string) => void;
  heading?: string;
}) {
  const blocking = round.questions.filter((q) => q.blocking);
  return (
    <Panel
      title={heading ?? `${round.origin === "feedback" ? "Refused — methodology route" : "Blocked"} · gate ${round.gate}`}
      right={
        <span className="font-mono text-[10px] text-ink-3">
          {blocking.length} blocking · {round.questions.length - blocking.length} non-blocking · {round.source}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {round.questions.map((q) => (
          <ClarificationCard
            key={q.id}
            question={q}
            answer={answers?.[q.id ?? ""]}
            onAnswer={onAnswer && q.id ? (t) => onAnswer(q.id!, t) : undefined}
          />
        ))}
        {round.nonBlockingNote && !round.questions.some((q) => !q.blocking) && (
          <div className="border border-line bg-ground p-3">
            <p className="font-mono text-[10px] tracking-wider text-ink-3">NON-BLOCKING</p>
            <Verbatim text={round.nonBlockingNote} />
          </div>
        )}
      </div>
    </Panel>
  );
}
