/**
 * `val/config.json` — the subset Studio reads.
 *
 * Typed against @valiify/val-core/schema/val.config.schema.json. Studio reads
 * `design.surfaces` and NEVER hardcodes a surface list: a surface added to the
 * target repo's config appears in Studio's picker on the next read, with its own
 * brief schema, regions, viewports and stop triggers.
 */

/** One `design.surfaces.<id>.briefSchema` row — drives the intake form generator. */
export interface BriefSchemaField {
  /** The exact `## <heading>` the pipeline expects in 01-brief.md. Order is significant. */
  heading: string;
  /** Rendered as the field's placeholder / helper text. Often a table shape. */
  hint?: string;
  /** A ★ heading in the methodology's §6 sense: missing → `brief-missing-field`. */
  required?: boolean;
}

/** A surface's own stop trigger, additional to the methodology's five. */
export interface SurfaceStopTrigger {
  trigger: string;
  when: string;
}

/** A viewport the concept must draw — one `<main data-concept>` each (§7). */
export interface SurfaceViewport {
  id: string;
  note?: string;
}

/** `design.surfaces.<id>` — the surface block rendered into every design agent (§1b). */
export interface DesignSurface {
  displayName?: string;
  /** Methodology file name, relative to `design.methodologyDir`. */
  methodology: string;
  flows?: string[];
  viewports?: SurfaceViewport[];
  /** The `data-region` vocabulary for this surface. */
  regions?: string[];
  briefSchema?: BriefSchemaField[];
  stopTriggers?: SurfaceStopTrigger[];
  /** The sections concept.md opens with. */
  conceptSections?: string[];
}

export interface DesignOutput {
  framework?: string;
  svelteMajor?: string;
  pagesDir?: string;
  componentsDir?: string;
}

export interface ValConfig {
  library: {
    name: string;
    displayName?: string;
    package?: string;
    figmaFileKey?: string;
    figmaFileName?: string;
  };
  paths: {
    runOutputDir?: string;
    toolsDir?: string;
    libraryRoot?: string;
    componentRegistry?: string;
    designSystemSkill?: string;
    [k: string]: string | undefined;
  };
  pipelines?: { val?: boolean; extract?: boolean; design?: boolean };
  design?: {
    methodologyDir?: string;
    surfaces?: Record<string, DesignSurface>;
    output?: DesignOutput;
  };
}

/** A surface flattened for the picker, with its id folded in. */
export interface SurfaceSummary extends DesignSurface {
  id: string;
  /** Repo-relative path to the methodology file. */
  methodologyPath: string;
  /** False when the methodology file named by the config is not on disk (Gate 0 stop). */
  methodologyExists: boolean;
  briefSchemaFieldCount: number;
  requiredFieldCount: number;
}

/** What `GET /api/target` returns — the target repo Studio is pointed at. */
export interface TargetRepoInfo {
  /** Absolute path on disk. May contain spaces. */
  root: string;
  configPath: string;
  library: ValConfig["library"];
  methodologyDir: string;
  runOutputDir: string;
  toolsDir: string;
  designPipelineEnabled: boolean;
  surfaces: SurfaceSummary[];
  output?: DesignOutput;
}
