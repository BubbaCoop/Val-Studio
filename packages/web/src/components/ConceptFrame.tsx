/**
 * The concept viewer — the real drawing in an iframe, with interactive hotspots.
 *
 * The concept is rendered EXACTLY as the pipeline wrote it, styled only by the
 * pipeline's concept.css. Studio adds no markup and no CSS to it: the grey-box
 * wireframe is the contract, and a Studio that prettified it would be showing the
 * designer something the critic never saw.
 *
 * The overlay is drawn by the PARENT, positioned from geometry the injected bridge
 * posts over postMessage. That keeps Studio off the frame's document entirely, so a
 * hosted runner can serve the concept from another origin without changing this
 * component.
 *
 * Hover surfaces the attributes ALREADY ON the block — data-region, data-class,
 * data-methodology, data-states, data-copy. Studio does not compute, infer or
 * enrich them; it shows what the architect declared.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConceptBlock } from "@valiify/studio-shared";
import { Tag } from "./ui.tsx";

interface BridgeBlock {
  id: string;
  viewport: string | null;
  rect: { x: number; y: number; w: number; h: number };
  depth: number;
  attrs: Record<string, string>;
}

export function ConceptFrame({
  src, blocks, selectedId, onSelect, version,
}: {
  src: string;
  /** The parsed blocks, so the overlay can show declared attributes even before layout. */
  blocks: ConceptBlock[];
  selectedId: string | null;
  onSelect: (blockId: string) => void;
  version: number;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [geometry, setGeometry] = useState<BridgeBlock[]>([]);
  const [doc, setDoc] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState<string | null>(null);
  const byId = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data;
      if (!data || data.source !== "val-studio-concept") return;
      if (data.type === "blocks") {
        setGeometry(data.blocks as BridgeBlock[]);
        setDoc(data.doc as { width: number; height: number });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // A new version is a new document: drop stale geometry rather than drawing last
  // version's hotspots over this one.
  useEffect(() => {
    setGeometry([]);
    setHovered(null);
  }, [src]);

  const hoveredBlock = hovered ? byId.get(hovered) : null;

  return (
    <div className="relative">
      <div className="relative overflow-auto border border-line bg-[#e9e9e6]" style={{ maxHeight: "72vh" }}>
        <div className="relative" style={{ height: doc.height || 600 }}>
          <iframe
            ref={frameRef}
            src={src}
            title={`concept v${version}`}
            className="block w-full border-0"
            style={{ height: doc.height || 600 }}
            onLoad={() => frameRef.current?.contentWindow?.postMessage({ type: "remeasure" }, "*")}
          />
          {/* Hotspots. Pointer events only on the spots themselves, so the drawing
              underneath still scrolls and selects normally. */}
          <div className="pointer-events-none absolute inset-0">
            {geometry.map((g) => {
              const declared = byId.get(g.id);
              const isSelected = selectedId === g.id;
              const isHovered = hovered === g.id;
              const blocked = !!declared?.blocked;
              return (
                <button
                  key={`${g.viewport}-${g.id}-${g.rect.y}`}
                  className={`pointer-events-auto absolute cursor-pointer border-2 transition-colors ${
                    isSelected
                      ? "border-blocking bg-blocking/10"
                      : isHovered
                        ? "border-ink/70 bg-ink/5"
                        : blocked
                          ? "border-blocking/40 bg-transparent"
                          : "border-transparent bg-transparent"
                  }`}
                  style={{ left: g.rect.x, top: g.rect.y, width: g.rect.w, height: g.rect.h, zIndex: 10 + g.depth }}
                  onMouseEnter={() => setHovered(g.id)}
                  onMouseLeave={() => setHovered((h) => (h === g.id ? null : h))}
                  onClick={() => onSelect(g.id)}
                  title={`${g.id}${declared?.region ? ` · ${declared.region}` : ""}`}
                >
                  <span
                    className={`absolute -top-px -left-px px-1 font-mono text-[9px] leading-4 ${
                      isSelected ? "bg-blocking text-white" : isHovered ? "bg-ink text-white" : "sr-only"
                    }`}
                  >
                    {g.id}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {!geometry.length && (
        <p className="mt-2 font-mono text-[10px] text-ink-3">
          waiting for the concept to report its blocks…
        </p>
      )}

      {/* Hover detail — the attributes the architect already put on the block. */}
      {hoveredBlock && <BlockAttributes block={hoveredBlock} />}
    </div>
  );
}

export function BlockAttributes({ block }: { block: ConceptBlock }) {
  return (
    <div className="mt-2 border border-line bg-panel p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag>{block.id}</Tag>
        {block.region && <Tag>{block.region}</Tag>}
        {block.archetype && <Tag>{block.archetype}</Tag>}
        {block.parent && <Tag>inside {block.parent}</Tag>}
        {block.blocked && <Tag tone="blocking">BLOCKED: {block.blocked}</Tag>}
      </div>
      <Row label="data-class" values={block.classes} mono />
      <Row label="data-methodology" values={block.methodology} />
      <Row label="data-states" values={block.states} />
      <Row label="data-copy" values={block.copy} />
      {block.labels.length > 0 && (
        <div className="mt-2">
          <p className="font-mono text-[10px] tracking-wider text-ink-3">content</p>
          <p className="mt-0.5 text-xs text-ink-2">{block.labels.join(" · ")}</p>
        </div>
      )}
    </div>
  );
}

function Row({ label, values, mono }: { label: string; values: string[]; mono?: boolean }) {
  if (!values.length) return null;
  return (
    <div className="mt-2">
      <p className="font-mono text-[10px] tracking-wider text-ink-3">{label}</p>
      <p className={`mt-0.5 text-xs break-words text-ink-2 ${mono ? "font-mono" : ""}`}>{values.join(" ")}</p>
    </div>
  );
}
