/**
 * The gate rail — where a run is, and why.
 *
 * Each stage is derived from the run directory, and every transition carries the
 * file that caused it. The loop counters are the important part:
 *
 *   - the CRITIC counter is shown against its cap of 3. Studio surfaces the cap and
 *     never offers to raise it: a critic that cannot converge in three passes is a
 *     defect, and the run's answer is needs-human-review.
 *   - FEEDBACK rounds are shown WITHOUT a cap, because they have none. A reviewer
 *     iterating is the product working. Presenting them as capped — even visually,
 *     even as "3 of ∞" — would cap the reviewer for a reason that has nothing to do
 *     with them.
 */
import type { LoopState, RunStage } from "@valiify/studio-shared";
import { RUN_STAGE_ORDER } from "@valiify/studio-shared";
import { Tag } from "./ui.tsx";

const LABELS: Record<RunStage, string> = {
  setup: "Gate 0 · setup",
  intake: "Gate 1 · intake",
  "blocked-brief": "Gate 1 · blocked",
  concept: "Gate 2 · concept",
  critique: "Gate 3 · critique",
  "awaiting-approval": "Gate 4 · human gate",
  approved: "Gate 4b · sealed",
  build: "Gate 5 · build",
  verified: "Gate 6 · verified",
  "signed-off": "Gate 7 · signed off",
  "needs-human-review": "needs human review",
};

export function GateRail({
  stage, loops, transitions,
}: {
  stage: RunStage;
  loops: LoopState;
  transitions?: { to: RunStage; because: string }[];
}) {
  const order = RUN_STAGE_ORDER.filter((s) => s !== "blocked-brief" || stage === "blocked-brief");
  const current = order.indexOf(stage);
  const latest = transitions?.at(-1);

  return (
    <div className="border border-line bg-panel">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 p-3">
        {order.map((s, i) => {
          const done = current > i;
          const here = current === i;
          return (
            <li key={s} className="flex items-center gap-1">
              <span
                className={`border px-2 py-1 font-mono text-[10px] whitespace-nowrap ${
                  here
                    ? "border-ink bg-ink text-white"
                    : done
                      ? "border-ok/40 bg-ok/10 text-ok"
                      : "border-line bg-ground text-ink-3"
                }`}
              >
                {LABELS[s]}
              </span>
              {i < order.length - 1 && <span className="text-ink-3">·</span>}
            </li>
          );
        })}
        {stage === "needs-human-review" && <Tag tone="blocking">{LABELS["needs-human-review"]}</Tag>}
      </ol>

      <div className="flex flex-wrap items-center gap-4 border-t border-line px-3 py-2">
        <div className="flex items-center gap-1.5" title="A critic that cannot converge in 3 passes is a defect, not a budget to raise.">
          <span className="font-mono text-[10px] tracking-wider text-ink-3">CRITIC LOOP</span>
          <Tag tone={loops.critic >= loops.criticCap ? "blocking" : "neutral"}>
            {loops.critic} / {loops.criticCap}
          </Tag>
          {loops.critic >= loops.criticCap && <span className="text-[10px] text-blocking">cap reached</span>}
        </div>

        <div className="flex items-center gap-1.5" title="Feedback rounds are uncapped and separate from the critic loop.">
          <span className="font-mono text-[10px] tracking-wider text-ink-3">FEEDBACK ROUNDS</span>
          {/* No cap, and no denominator: there is nothing to count against. */}
          <Tag>{loops.feedback}</Tag>
          <span className="text-[10px] text-ink-3">uncapped</span>
        </div>

        {loops.verify > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] tracking-wider text-ink-3">VERIFY LOOP</span>
            <Tag>{loops.verify} / {loops.verifyCap}</Tag>
          </div>
        )}
      </div>

      {latest && (
        <p className="border-t border-line px-3 py-1.5 font-mono text-[10px] text-ink-3">
          → {LABELS[latest.to]} — {latest.because}
        </p>
      )}
    </div>
  );
}
