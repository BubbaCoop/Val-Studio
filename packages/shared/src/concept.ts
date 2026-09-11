/**
 * The grey-box concept contract (methodology §7, tools/design/concept.css).
 *
 * A concept is a wireframe with NO class attributes: the real library classes live
 * in `data-class`. Studio parses these attributes to drive the hotspot overlay —
 * hovering a block surfaces exactly the attributes already on it, nothing more.
 */

/** One `<section data-block>` in a concept. Blocks nest (a roster card with rows). */
export interface ConceptBlock {
  /** Stable id `b01…`. Ids never change between versions — which is why feedback pins a version. */
  id: string;
  /** The shell part, from the surface's region vocabulary. */
  region?: string;
  /** The §2 archetype of the page — the same on every block. */
  archetype?: string;
  /** Every library class / sanctioned utility, components with a leading dot. */
  classes: string[];
  /** The §s that determine this block. */
  methodology: string[];
  /** The states this block has (§6); each must be reachable in the build via a prop. */
  states: string[];
  /** Copy ids from concept.md's copy table. */
  copy: string[];
  /** Set when the architect marked the block BLOCKED in the drawing itself. */
  blocked?: string;
  /** Which viewport's `<main>` this block belongs to. */
  viewport: string;
  /** Parent block id, for nested blocks. */
  parent?: string;
  /** Visible label text inside the block, for the composer's context. */
  labels: string[];
}

/** One `<main data-concept>` — a concept has one per viewport the surface defines. */
export interface ConceptViewport {
  id: string;
  title?: string;
  blockIds: string[];
}

/** One row of concept.md's copy table: `| id | role | text | source | §8 rule |`. */
export interface CopyRow {
  id: string;
  role?: string;
  text: string;
  /** `DRAFT` copy is what the human gate must explicitly approve (§5). */
  source: "brief" | "DRAFT" | "methodology" | (string & {});
  rule?: string;
}

export interface ConceptVersion {
  /** The `n` in concept.v<n>.html. */
  version: number;
  fileName: string;
  /** Run-relative path. */
  path: string;
  mtime: string;
}

/** A parsed concept — what the concept-review screen renders overlays from. */
export interface ConceptDoc {
  version: number;
  fileName: string;
  title?: string;
  viewports: ConceptViewport[];
  blocks: ConceptBlock[];
  /** Every copy id the concept references, via data-copy or data-copy-id. */
  copyIds: string[];
  /** Copy ids carrying data-copy-source="DRAFT" in the drawing. */
  draftCopyIds: string[];
}
