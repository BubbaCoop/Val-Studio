/**
 * Handoff — the package, after VERIFY: PASS.
 *
 * contract.json is rendered as the seven groups the contract schema defines and
 * nothing else: blocks, fields, states, actions, copy, icons, planned. It is the
 * machine-readable half of the package, so it is shown as it is, never summarised
 * into prose. Beside it: the package's own file list, and HANDOFF.md — the document
 * the dev team actually receives — read verbatim off disk.
 */
import { useEffect, useState } from "react";
import type { DesignContract, RunDetail } from "@valiify/studio-shared";
import { api } from "../api.ts";
import { Banner, Empty, Panel, Tag, Verbatim } from "../components/ui.tsx";

export function Handoff({ run }: { run: RunDetail }) {
  const c = run.contract;
  const verified = run.verifications.at(-1)?.verdict === "PASS";

  if (!c) {
    return (
      <Panel title="Handoff">
        {run.packageFiles.length > 0 ? (
          <Banner tone="blocking" title="05-package/ exists but carries no readable contract.json">
            handoff-check validates the package against tools/design/contract.schema.json, so a package without a
            readable contract has not passed Gate 6. The files that are there are listed below.
          </Banner>
        ) : (
          <Empty>No 05-package/ yet — the build has not run.</Empty>
        )}
        {run.packageFiles.length > 0 && <PackageFiles files={run.packageFiles} />}
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Contract"
        right={
          <Tag tone={verified ? "ok" : "draft"}>
            {verified ? `VERIFY: PASS · ${run.verifications.at(-1)!.fileName}` : "not yet verified"}
          </Tag>
        }
      >
        {!verified && (
          <Banner tone="draft" title="This package has not reported VERIFY: PASS">
            The contract below is what the builder wrote. Gate 6 has not signed it off, so treat it as in flight.
          </Banner>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Tag>{c.route}</Tag>
          <Tag>{c.archetype}</Tag>
          {c.surface && <Tag>{c.surface}</Tag>}
          {c.step && <Tag>step {c.step.n} of {c.step.m} · {c.step.section}</Tag>}
        </div>
      </Panel>

      <Group title="Blocks" count={c.blocks.length} columns={["id", "region", "component", "file", "classes"]}
        rows={c.blocks.map((b) => [b.id, b.region ?? "—", b.component ?? "—", b.file, (b.classes ?? []).join(" ")])} />

      <Group title="Fields" count={(c.fields ?? []).length} columns={["id", "label", "type", "required", "placeholder", "bind"]}
        rows={(c.fields ?? []).map((f) => [f.id, f.label, f.type, f.required ? "yes" : "no", f.placeholder ?? "—", f.bind ?? "—"])} />

      <Group title="States" count={c.states.length} columns={["id", "when", "blocks"]}
        rows={c.states.map((s) => [s.id, s.when, s.blocks.join(" ")])} />

      <Group title="Actions" count={c.actions.length} columns={["id", "label", "kind", "enabledWhen", "emits"]}
        rows={c.actions.map((a) => [a.id, a.label, a.kind, a.enabledWhen ?? "—", a.emits ?? "—"])} />

      <CopyGroup contract={c} />

      <Panel title="Icons" right={<Tag>{(c.icons ?? []).length}</Tag>}>
        {(c.icons ?? []).length === 0 ? <Empty>None.</Empty> : (
          <div className="flex flex-wrap gap-1.5">{c.icons!.map((i) => <Tag key={i}>{i}</Tag>)}</div>
        )}
      </Panel>

      <Panel
        title="Planned"
        right={<Tag tone={(c.planned ?? []).length ? "draft" : "neutral"}>{(c.planned ?? []).length}</Tag>}
      >
        {(c.planned ?? []).length === 0 ? <Empty>No §12 interim classes used.</Empty> : (
          <ul className="flex flex-col gap-2">
            {c.planned!.map((p) => (
              <li key={p.class} className="border-l-2 border-draft bg-draft/5 p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Tag tone="draft">{p.class}</Tag>
                  <span className="font-mono text-[10px] text-ink-3">{p.ref}</span>
                  {p.blocks?.length ? <span className="font-mono text-[10px] text-ink-3">{p.blocks.join(" ")}</span> : null}
                </div>
                {p.value && <p className="mt-1 text-ink-2">{p.value}</p>}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[10px] text-ink-3">
          A §12 interim class is the one sanctioned spelling of a value the library has not shipped. The dev team
          swaps these when it does.
        </p>
      </Panel>

      <Panel title="Package" right={<Tag>{run.packageFiles.length} files</Tag>}>
        <PackageFiles files={run.packageFiles} />
      </Panel>

      {/* The documents the dev team receives, verbatim. Studio renders, never rewrites. */}
      <RunFile run={run} path="05-package/HANDOFF.md" title="HANDOFF.md" />
      <RunFile run={run} path="05-package/mapping.md" title="mapping.md" />
      {run.writeup && (
        <Panel title="07-writeup.md" right={<Tag tone="ok">signed off</Tag>}>
          <Verbatim text={run.writeup} />
        </Panel>
      )}
    </div>
  );
}

function PackageFiles({ files }: { files: string[] }) {
  if (!files.length) return <Empty>None.</Empty>;
  return (
    <ul className="flex flex-col gap-0.5 font-mono text-[10px] text-ink-2">
      {files.map((f) => <li key={f}>{f}</li>)}
    </ul>
  );
}

/** One file out of the run directory, rendered verbatim. */
function RunFile({ run, path, title }: { run: RunDetail; path: string; title: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const present = run.packageFiles.includes(path.replace("05-package/", ""));

  useEffect(() => {
    if (!present) return;
    setError(null);
    api.file(run.runId, path).then(setText).catch((e: Error) => setError(e.message));
  }, [run.runId, path, present]);

  if (!present) return null;
  return (
    <Panel title={title} right={<span className="font-mono text-[10px] text-ink-3">{path}</span>}>
      {error ? <Banner tone="blocking" title={`Cannot read ${path}`}>{error}</Banner> : null}
      {text !== null ? <Verbatim text={text} /> : error ? null : <Empty>Reading…</Empty>}
    </Panel>
  );
}

function CopyGroup({ contract }: { contract: DesignContract }) {
  const drafted = contract.copy.filter((c) => c.source === "DRAFT");
  return (
    <Panel
      title="Copy"
      right={
        <span className="flex items-center gap-1.5">
          <Tag>{contract.copy.length}</Tag>
          {drafted.length > 0 && <Tag tone="draft">{drafted.length} DRAFT</Tag>}
        </span>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-line">
              {["id", "role", "text", "source", "verbatim"].map((h) => (
                <th key={h} className="px-2 py-1 font-mono text-[10px] tracking-wider text-ink-3 uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {contract.copy.map((c) => (
              <tr key={c.id} className={`border-b border-line/60 align-top ${c.source === "DRAFT" ? "bg-draft/5" : ""}`}>
                <td className="px-2 py-1.5 font-mono">{c.id}</td>
                <td className="px-2 py-1.5 text-ink-3">{c.role ?? "—"}</td>
                <td className="px-2 py-1.5">{c.text}</td>
                <td className="px-2 py-1.5">
                  <Tag tone={c.source === "DRAFT" ? "draft" : "neutral"}>{c.source}</Tag>
                </td>
                <td className="px-2 py-1.5 font-mono text-[10px] text-ink-3">
                  {c.verbatimInMarkup === false ? "styled" : "yes"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Group({ title, count, columns, rows }: { title: string; count: number; columns: string[]; rows: string[][] }) {
  return (
    <Panel title={title} right={<Tag>{count}</Tag>}>
      {rows.length === 0 ? <Empty>None.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-line">
                {columns.map((h) => (
                  <th key={h} className="px-2 py-1 font-mono text-[10px] tracking-wider text-ink-3 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-line/60 align-top">
                  {r.map((cell, j) => (
                    <td key={j} className={`px-2 py-1.5 ${j === 0 ? "font-mono" : "text-ink-2"}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
