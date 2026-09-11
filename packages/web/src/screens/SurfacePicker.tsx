/**
 * Surface picker — reads the target repo's val/config.json → design.surfaces.
 *
 * The list is NEVER hardcoded. Everything shown here — display name, methodology
 * file, viewports, region vocabulary, brief schema size, stop triggers — comes from
 * the config as it is on disk right now. Add a surface to the target repo and it
 * appears here on the next read, with its own form, its own regions and its own
 * stop triggers. That is the whole point of this screen.
 */
import type { SurfaceSummary, TargetRepoInfo } from "@valiify/studio-shared";
import { Empty, Panel, Tag } from "../components/ui.tsx";

export function SurfacePicker({
  target, onPick,
}: {
  target: TargetRepoInfo;
  onPick: (surface: SurfaceSummary) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Target library"
        right={<span className="font-mono text-[10px] text-ink-3">{target.configPath}</span>}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Tag>{target.library.name}</Tag>
          {target.library.package && <Tag>{target.library.package}</Tag>}
          <Tag>{target.output?.framework ?? "no output framework"}</Tag>
          <Tag>{target.methodologyDir}/</Tag>
          <Tag>{target.runOutputDir}/</Tag>
          {!target.designPipelineEnabled && <Tag tone="blocking">design pipeline disabled</Tag>}
        </div>
      </Panel>

      <Panel
        title="Surfaces"
        right={<span className="font-mono text-[10px] text-ink-3">from design.surfaces — never hardcoded</span>}
      >
        {target.surfaces.length === 0 ? (
          <Empty>
            val/config.json has no <code className="font-mono">design.surfaces</code>. Studio has nothing to
            offer until the target repo configures one.
          </Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {target.surfaces.map((s) => (
              <button
                key={s.id}
                onClick={() => s.methodologyExists && onPick(s)}
                disabled={!s.methodologyExists}
                className="border border-line bg-ground p-4 text-left transition hover:border-ink disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold">{s.displayName ?? s.id}</h3>
                  <span className="font-mono text-[10px] text-ink-3">{s.id}</span>
                </div>
                <p className="mt-1 font-mono text-[10px] text-ink-3">{s.methodologyPath}</p>

                {!s.methodologyExists && (
                  <p className="mt-2 border-l-2 border-blocking pl-2 text-xs text-blocking">
                    Methodology file missing — /design stops at Gate 0.
                  </p>
                )}

                <dl className="mt-3 flex flex-wrap gap-1.5">
                  <Tag>{s.briefSchemaFieldCount} brief headings</Tag>
                  <Tag tone={s.requiredFieldCount ? "draft" : "neutral"}>{s.requiredFieldCount} required</Tag>
                  {(s.viewports ?? []).map((v) => <Tag key={v.id}>{v.id}</Tag>)}
                  <Tag>{(s.regions ?? []).length} regions</Tag>
                  <Tag tone="blocking">{(s.stopTriggers ?? []).length} stop triggers</Tag>
                </dl>

                {s.flows?.length ? (
                  <p className="mt-2 text-[10px] text-ink-3">flows: {s.flows.join(" · ")}</p>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
