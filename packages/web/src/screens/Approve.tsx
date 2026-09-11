/**
 * Approve — one action, which invokes `/design build <run-dir>`.
 *
 * Invoking the command IS the approval. Studio does not write 04-approval.md, does
 * not compute the sha256, and does not decide the run is approvable: Gate 4b does
 * all three. This screen collects the reviewer's message, which the pipeline records
 * verbatim in the approval file, and shows what is being approved.
 */
import { useState } from "react";
import type { RunDetail } from "@valiify/studio-shared";
import { api } from "../api.ts";
import { Button, Panel, Tag, Verbatim } from "../components/ui.tsx";

export function Approve({ run, onApproved }: { run: RunDetail; onApproved: () => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const latest = run.concepts.at(-1);
  const draftCopy = run.copy.filter((c) => c.source === "DRAFT");
  const lastCritique = run.critiques.at(-1);

  if (run.approval) {
    return (
      <Panel
        title="Approval — sealed by the pipeline"
        right={<Tag tone={run.approvalHashValid === false ? "blocking" : "ok"}>
          {run.approvalHashValid === false ? "HASH MISMATCH — approval void" : "sealed"}
        </Tag>}
      >
        {run.approvalHashValid === false && (
          <p className="mb-3 border-l-2 border-blocking bg-blocking/5 p-2 text-xs text-blocking">
            {run.approval.concept} no longer hashes to the sealed value. The approval is void and the reviewer must
            re-approve. Studio did not compute this seal — it re-checked it.
          </p>
        )}
        <Verbatim text={run.approval.text} />
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel title="What you are approving">
        <dl className="grid gap-2 text-xs sm:grid-cols-2">
          <Row label="concept" value={latest?.fileName ?? "—"} />
          <Row label="critique" value={lastCritique ? `${lastCritique.verdict} · ${lastCritique.blocking} blocking` : "—"} />
          <Row label="DRAFT copy" value={`${draftCopy.length} string(s) — approval covers them`} />
          <Row label="feedback rounds" value={`${run.loops.feedback} (uncapped)`} />
        </dl>
        <p className="mt-3 text-[10px] text-ink-3">
          Approval does not authorise invented style. A finding that asks for what the methodology forbids comes
          back with a ROUTE, not a compromise.
        </p>
      </Panel>

      <Panel title="Your approving message — recorded verbatim in 04-approval.md">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          placeholder="Approved as v2. Name row stands. Footer offset is a §1.2 methodology gap — leave it recorded."
          className="w-full resize-y border border-line bg-ground p-2 font-mono text-xs"
        />
        <p className="mt-2 text-[10px] text-ink-3">
          The pipeline writes the file and computes the sha256. Studio never does either.
        </p>
      </Panel>

      <div className="flex justify-end">
        <Button
          kind="primary"
          disabled={busy || !message.trim()}
          onClick={async () => {
            setBusy(true);
            await api.approve(run.runId, message);
            setBusy(false);
            onApproved();
          }}
        >
          {busy ? "Running…" : `Approve — /design build ${run.relPath}`}
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="font-mono text-[10px] tracking-wider text-ink-3">{label}</dt>
      <dd className="text-ink-2">{value}</dd>
    </div>
  );
}
