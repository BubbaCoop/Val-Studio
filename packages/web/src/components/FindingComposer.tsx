/**
 * The critique-finding composer.
 *
 * Produces rows of the pipeline's table — `| id | block | severity | rule | finding
 * | fix |` — the SAME table the critic uses, so one rework path serves both. Ids are
 * H1, H2 … because the ledger records that a human asked.
 *
 * Two constraints are enforced here rather than discovered at validation:
 *   - `fix` must say what to DO, not merely what is wrong. It is the column the
 *     architect acts on, and an empty one fails feedback-check.
 *   - `block` must be a target that exists in the concept BEING REVIEWED. The
 *     picker is populated from that concept's own ids, so a stale id cannot be
 *     typed in the first place.
 *
 * `rule` is optional and stays optional: a designer is not expected to cite a §.
 */
import { useState } from "react";
import type { ConceptDoc, FeedbackFinding, FindingSeverity } from "@valiify/studio-shared";
import { Button, Tag } from "./ui.tsx";

export function FindingComposer({
  concept, seedBlock, onAdd, onCancel,
}: {
  concept: ConceptDoc;
  seedBlock?: string | null;
  onAdd: (f: Omit<FeedbackFinding, "id">) => void;
  onCancel: () => void;
}) {
  const [block, setBlock] = useState(seedBlock ?? "-");
  const [severity, setSeverity] = useState<FindingSeverity>("blocking");
  const [rule, setRule] = useState("");
  const [finding, setFinding] = useState("");
  const [fix, setFix] = useState("");

  const blockIds = [...new Set(concept.blocks.map((b) => b.id))].sort();
  const selected = concept.blocks.find((b) => b.id === block);
  const canAdd = fix.trim().length > 0 && block.trim().length > 0;

  return (
    <form
      className="border border-ink bg-panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canAdd) return;
        onAdd({ block: block.trim(), severity, rule: rule.trim(), finding: finding.trim(), fix: fix.trim() });
        setFinding("");
        setFix("");
        setRule("");
      }}
    >
      <header className="flex items-center justify-between border-b border-line px-4 py-2">
        <h3 className="text-xs font-semibold tracking-[0.08em] text-ink-2 uppercase">New finding</h3>
        <span className="font-mono text-[10px] text-ink-3">against {concept.fileName}</span>
      </header>

      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-wider text-ink-3">BLOCK</span>
          <select
            value={block}
            onChange={(e) => setBlock(e.target.value)}
            className="border border-line bg-ground p-2 font-mono text-xs"
          >
            {/* "-" is the methodology's own value for feedback about the whole page. */}
            <option value="-">— the page as a whole</option>
            <optgroup label="blocks">
              {blockIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                  {concept.blocks.find((b) => b.id === id)?.region
                    ? ` · ${concept.blocks.find((b) => b.id === id)!.region}`
                    : ""}
                </option>
              ))}
            </optgroup>
            <optgroup label="copy">
              {concept.copyIds.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </optgroup>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-wider text-ink-3">SEVERITY</span>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as FindingSeverity)}
            className="border border-line bg-ground p-2 font-mono text-xs"
          >
            <option value="blocking">blocking</option>
            <option value="advisory">advisory</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="font-mono text-[10px] tracking-wider text-ink-3">
            RULE <span className="normal-case">— optional; a designer need not cite a §</span>
          </span>
          <input
            value={rule}
            onChange={(e) => setRule(e.target.value)}
            placeholder="§5"
            className="border border-line bg-ground p-2 font-mono text-xs"
          />
        </label>

        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="font-mono text-[10px] tracking-wider text-ink-3">FINDING — what is wrong</span>
          <textarea
            value={finding}
            onChange={(e) => setFinding(e.target.value)}
            rows={2}
            placeholder="first name should be a dropdown"
            className="resize-y border border-line bg-ground p-2 text-xs"
          />
        </label>

        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="font-mono text-[10px] tracking-wider text-ink-3">
            FIX — what to DO <span className="text-blocking">*</span>
          </span>
          <textarea
            value={fix}
            onChange={(e) => setFix(e.target.value)}
            rows={2}
            placeholder="map to .dropdown-field"
            className="resize-y border border-line bg-ground p-2 text-xs"
          />
          <span className="text-[10px] text-ink-3">
            The architect acts on this column. A fix that only restates the problem fails feedback-check.
          </span>
        </label>

        {selected && (
          <div className="sm:col-span-2 border border-line bg-ground p-2">
            <p className="font-mono text-[10px] tracking-wider text-ink-3">declared on {selected.id}</p>
            <p className="mt-1 font-mono text-[10px] break-words text-ink-2">{selected.classes.join(" ") || "—"}</p>
            {selected.states.length > 0 && (
              <p className="mt-1 font-mono text-[10px] text-ink-3">states: {selected.states.join(" ")}</p>
            )}
          </div>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" kind="primary" disabled={!canAdd} title={canAdd ? undefined : "A finding needs a fix"}>
          Add finding
        </Button>
      </footer>
    </form>
  );
}

export function FindingRows({
  findings, onRemove,
}: {
  findings: FeedbackFinding[];
  onRemove?: (id: string) => void;
}) {
  if (!findings.length) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-line">
            {["id", "block", "severity", "rule", "finding", "fix"].map((h) => (
              <th key={h} className="px-2 py-1 font-mono text-[10px] tracking-wider text-ink-3 uppercase">{h}</th>
            ))}
            {onRemove && <th />}
          </tr>
        </thead>
        <tbody>
          {findings.map((f) => (
            <tr key={f.id} className="border-b border-line/60 align-top">
              <td className="px-2 py-1.5 font-mono"><Tag>{f.id}</Tag></td>
              <td className="px-2 py-1.5 font-mono">{f.block}</td>
              <td className="px-2 py-1.5">
                <Tag tone={f.severity === "blocking" ? "blocking" : "neutral"}>{f.severity}</Tag>
              </td>
              <td className="px-2 py-1.5 font-mono text-ink-3">{f.rule || "—"}</td>
              <td className="px-2 py-1.5 text-ink-2">{f.finding || "—"}</td>
              <td className="px-2 py-1.5">{f.fix}</td>
              {onRemove && (
                <td className="px-2 py-1.5">
                  <button className="text-[10px] text-blocking underline" onClick={() => onRemove(f.id)}>remove</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
