/**
 * Parsing `02-concept/concept.v<n>.html` — the grey-box wireframe (§7).
 *
 * The concept carries NO class attributes by contract; the real library classes
 * live in `data-class`. This parser reads only the data-* attributes the contract
 * defines, keeps block nesting (a roster card containing rows), and records which
 * `<main data-concept>` each block belongs to.
 *
 * Hand-rolled rather than DOM-parsed on purpose: the concept is a machine-written
 * document with a fixed shape, and adding a parser dependency to read a contract
 * this narrow is not worth it.
 */
import type { ConceptBlock, ConceptDoc, ConceptViewport } from "@valiify/studio-shared";

const TAG_RE = /<(\/?)(main|section)\b([^>]*)>/gi;
const ATTR_RE = /([a-zA-Z-]+)(?:\s*=\s*"([^"]*)")?/g;

function attrs(chunk: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(chunk))) out[m[1].toLowerCase()] = m[2] ?? "";
  return out;
}

const list = (v: string | undefined): string[] => (v ? v.split(/\s+/).filter(Boolean) : []);

/** Visible `data-label` text inside a block, excluding text belonging to nested blocks. */
function labelsIn(html: string): string[] {
  const out: string[] = [];
  const re = /<([a-z]+)\b[^>]*\sdata-label\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const text = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out;
}

export function parseConcept(html: string, version: number, fileName: string): ConceptDoc {
  const blocks: ConceptBlock[] = [];
  const viewports: ConceptViewport[] = [];
  /** Open elements, innermost last. `block` is null for a `<main>` or an untagged section. */
  const stack: { tag: string; block: ConceptBlock | null; viewport: string | null; contentStart: number }[] = [];
  let viewport = "";

  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html))) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const chunk = m[3] ?? "";

    if (closing) {
      // Find the matching open tag, tolerating a malformed document rather than throwing.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag !== tag) continue;
        const frame = stack[i];
        if (frame.block) {
          const inner = html.slice(frame.contentStart, m.index);
          // Strip nested sections so a parent does not inherit its children's labels.
          frame.block.labels = labelsIn(inner.replace(/<section\b[\s\S]*?<\/section>/gi, ""));
        }
        stack.length = i;
        if (tag === "main") viewport = "";
        break;
      }
      continue;
    }
    if (chunk.trimEnd().endsWith("/")) continue; // self-closing; carries no block

    const a = attrs(chunk);

    if (tag === "main" && "data-concept" in a) {
      viewport = a["data-viewport"] || `viewport-${viewports.length + 1}`;
      viewports.push({ id: viewport, title: a["data-title"] || undefined, blockIds: [] });
      stack.push({ tag, block: null, viewport, contentStart: TAG_RE.lastIndex });
      continue;
    }

    if (tag === "section" && a["data-block"]) {
      const parent = [...stack].reverse().find((f) => f.block)?.block;
      const block: ConceptBlock = {
        id: a["data-block"],
        region: a["data-region"] || undefined,
        archetype: a["data-archetype"] || undefined,
        classes: list(a["data-class"]),
        methodology: list(a["data-methodology"]),
        states: list(a["data-states"]),
        copy: list(a["data-copy"]),
        blocked: a["data-blocked"] || undefined,
        viewport,
        parent: parent?.id,
        labels: [],
      };
      blocks.push(block);
      viewports.find((v) => v.id === viewport)?.blockIds.push(block.id);
      stack.push({ tag, block, viewport, contentStart: TAG_RE.lastIndex });
      continue;
    }

    stack.push({ tag, block: null, viewport, contentStart: TAG_RE.lastIndex });
  }

  // Copy ids, gathered exactly the way feedback-check.mjs gathers them, so a target
  // Studio shows as valid is a target the validator will also accept.
  const copyIds = new Set<string>();
  for (const mm of html.matchAll(/\sdata-copy\s*=\s*"([^"]+)"/g)) {
    for (const id of mm[1].split(/\s+/).filter(Boolean)) copyIds.add(id);
  }
  for (const mm of html.matchAll(/\sdata-copy-id\s*=\s*"([^"]+)"/g)) copyIds.add(mm[1]);

  const draftCopyIds = new Set<string>();
  for (const mm of html.matchAll(/<[^>]*\sdata-copy-id\s*=\s*"([^"]+)"[^>]*>/g)) {
    if (/data-copy-source\s*=\s*"DRAFT"/.test(mm[0])) draftCopyIds.add(mm[1]);
  }

  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();

  return {
    version,
    fileName,
    title,
    viewports,
    blocks,
    copyIds: [...copyIds],
    draftCopyIds: [...draftCopyIds],
  };
}

/**
 * Rewrite the concept for the iframe.
 *
 * Two edits, both mechanical and neither touching the drawing:
 *   1. The concept links its stylesheet by a run-relative path (`../../../tools/…`)
 *      whose depth varies. It is repointed at the backend's concept.css endpoint.
 *   2. A bridge script is appended that posts each block's geometry and attributes
 *      to the parent. The overlay is drawn by the parent, so Studio never needs
 *      same-origin access to the frame and a hosted runner can serve it from
 *      anywhere.
 */
export function prepareConceptForFrame(html: string, cssUrl: string): string {
  let out = html.replace(
    /<link\b[^>]*rel\s*=\s*"stylesheet"[^>]*>/gi,
    `<link rel="stylesheet" href="${cssUrl}">`,
  );
  if (!/rel\s*=\s*"stylesheet"/i.test(out)) {
    out = out.replace(/<\/head>/i, `<link rel="stylesheet" href="${cssUrl}"></head>`);
  }
  const bridge = `
<script>
(function () {
  var send = function (type, payload) {
    parent.postMessage(Object.assign({ source: "val-studio-concept", type: type }, payload), "*");
  };
  var attrsOf = function (el) {
    var o = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name.indexOf("data-") === 0) o[a.name] = a.value;
    }
    return o;
  };
  var measure = function () {
    var blocks = [];
    document.querySelectorAll("[data-block]").forEach(function (el) {
      var r = el.getBoundingClientRect();
      var main = el.closest("[data-concept]");
      blocks.push({
        id: el.getAttribute("data-block"),
        viewport: main ? main.getAttribute("data-viewport") : null,
        rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height },
        depth: (function () { var d = 0, p = el.parentElement; while (p) { if (p.hasAttribute && p.hasAttribute("data-block")) d++; p = p.parentElement; } return d; })(),
        attrs: attrsOf(el)
      });
    });
    send("blocks", {
      blocks: blocks,
      doc: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }
    });
  };
  window.addEventListener("load", measure);
  window.addEventListener("resize", measure);
  if (window.ResizeObserver) new ResizeObserver(measure).observe(document.documentElement);
  window.addEventListener("message", function (e) { if (e.data && e.data.type === "remeasure") measure(); });
  document.addEventListener("scroll", function () { send("scroll", { x: window.scrollX, y: window.scrollY }); }, { passive: true });
  measure();
})();
</script>`;
  return /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${bridge}\n</body>`) : out + bridge;
}
