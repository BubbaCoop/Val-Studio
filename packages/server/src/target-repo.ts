/**
 * Reading the target repo's `val/config.json`.
 *
 * `design.surfaces` is the ONLY source of the surface list. Studio hardcodes no
 * surface, no region vocabulary and no brief schema: adding a surface to the target
 * repo's config makes it appear in the picker, with its own form, on the next read.
 *
 * The config is re-read on every request rather than cached at startup, so a repo
 * edited underneath a running Studio is picked up without a restart.
 */
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SurfaceSummary, TargetRepoInfo, ValConfig } from "@valiify/studio-shared";

export class TargetRepoError extends Error {}

export async function readValConfig(targetRepo: string): Promise<{ config: ValConfig; path: string }> {
  const path = join(targetRepo, "val", "config.json");
  if (!existsSync(path)) {
    throw new TargetRepoError(
      `No val/config.json at ${targetRepo}. Studio drives an existing val-inited library repo; run \`npx val-init\` there first.`,
    );
  }
  let config: ValConfig;
  try {
    config = JSON.parse(await readFile(path, "utf8")) as ValConfig;
  } catch (err) {
    throw new TargetRepoError(`val/config.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!config.library?.name) throw new TargetRepoError("val/config.json has no library.name.");
  return { config, path };
}

/** Defaults mirror val-core's own, so a config that omits a path still resolves. */
export function methodologyDirOf(config: ValConfig): string {
  return config.design?.methodologyDir ?? "design-methodology";
}
export function runOutputDirOf(config: ValConfig): string {
  return config.paths?.runOutputDir ?? "val/runs";
}
export function toolsDirOf(config: ValConfig): string {
  return config.paths?.toolsDir ?? "val/tools";
}

export async function readTargetRepo(targetRepo: string): Promise<TargetRepoInfo> {
  const { config, path } = await readValConfig(targetRepo);
  const methodologyDir = methodologyDirOf(config);
  const surfaces: SurfaceSummary[] = Object.entries(config.design?.surfaces ?? {}).map(([id, s]) => {
    const methodologyPath = join(methodologyDir, s.methodology);
    const schema = s.briefSchema ?? [];
    return {
      ...s,
      id,
      methodologyPath,
      // A missing methodology file is a Gate 0 stop in the pipeline; the picker
      // shows it rather than letting the requester start a run that cannot begin.
      methodologyExists: existsSync(join(targetRepo, methodologyPath)),
      briefSchemaFieldCount: schema.length,
      requiredFieldCount: schema.filter((f) => f.required).length,
    };
  });
  return {
    root: targetRepo,
    configPath: path,
    library: config.library,
    methodologyDir,
    runOutputDir: runOutputDirOf(config),
    toolsDir: toolsDirOf(config),
    designPipelineEnabled: config.pipelines?.design !== false,
    surfaces,
    output: config.design?.output,
  };
}

/** Absolute path to a val-core design tool inside the TARGET repo (val-init copies them there). */
export function designToolPath(targetRepo: string, config: ValConfig, tool: string): string {
  return resolve(targetRepo, toolsDirOf(config), "design", tool);
}

export async function fileMtime(path: string): Promise<string> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}
