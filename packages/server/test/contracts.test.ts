/**
 * The shared types must not drift from the schemas they claim to mirror.
 *
 * `@valiify/studio-shared` is hand-written TypeScript, because Studio has no build
 * step and adding a codegen dependency to read two schemas is not a trade worth
 * making. The cost of hand-writing is drift: val-core adds a contract field, Studio's
 * handoff screen silently never renders it, and nothing fails. So the types are not
 * checked BY the schema at compile time — they are checked AGAINST it here, from the
 * real files in node_modules/@valiify/val-core.
 *
 * Two directions, deliberately asymmetric:
 *   property names   must match exactly. A property in the schema that Studio does not
 *                    type is a field it will never show; one Studio types that the
 *                    schema does not have is invented.
 *   required-ness    every property Studio types as NON-optional must be `required` in
 *                    the schema. The reverse is allowed on purpose: Studio reads files
 *                    written by agents, and a reader that assumes a field is present
 *                    crashes on the one run where it is not.
 *
 * The fixtures are then validated against the schema itself, so "the type matches the
 * schema" is joined by "the schema matches what the pipeline actually writes".
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const SHARED = new URL("../../shared/src/", import.meta.url).pathname;
const REPO = process.env.VAL_STUDIO_TARGET_REPO ?? "/Users/nicholascooper/Desktop/valiify shortapp library";

const schema = (p: string): JsonSchema => JSON.parse(readFileSync(require.resolve(p), "utf8"));

interface JsonSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  [k: string]: unknown;
}

/**
 * The property names an interface declares, and which of them are non-optional.
 *
 * A regex over the source rather than a TypeScript AST: these files are a flat list of
 * plain interfaces with no generics and no inheritance beyond one `extends`, and the
 * test would otherwise need a compiler dependency to check a dozen field names.
 */
function tsInterface(file: string, name: string): { props: string[]; requiredProps: string[] } {
  const src = readFileSync(join(SHARED, file), "utf8");
  const start = src.indexOf(`export interface ${name} {`);
  ok(start >= 0, `${file} declares ${name}`);
  let depth = 0;
  let end = start;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = src.slice(src.indexOf("{", start) + 1, end);
  // Only top-level members: skip anything nested inside an inline object literal.
  const props: string[] = [];
  const requiredProps: string[] = [];
  let nest = 0;
  for (const line of body.split("\n")) {
    const m = nest === 0 ? /^\s{2}([A-Za-z_][A-Za-z0-9_]*)(\??):/.exec(line) : null;
    if (m) {
      props.push(m[1]);
      if (!m[2]) requiredProps.push(m[1]);
    }
    for (const ch of line) {
      if (ch === "{") nest++;
      else if (ch === "}") nest--;
    }
  }
  return { props: props.sort(), requiredProps: requiredProps.sort() };
}

function agrees(label: string, s: JsonSchema, file: string, name: string): void {
  const ts = tsInterface(file, name);
  deepStrictEqual(ts.props, Object.keys(s.properties ?? {}).sort(), `${label}: property names`);
  const required = new Set(s.required ?? []);
  const assumed = ts.requiredProps.filter((p) => !required.has(p));
  deepStrictEqual(assumed, [], `${label}: Studio treats these as always present, but the schema does not require them`);
}

describe("shared types agree with @valiify/val-core's schemas", () => {
  it("contract.json — every group the handoff screen renders", () => {
    const s = schema("@valiify/val-core/tools/design/contract.schema.json");
    const p = s.properties!;
    agrees("DesignContract", s, "contract.ts", "DesignContract");
    agrees("ContractBlock", p.blocks.items!, "contract.ts", "ContractBlock");
    agrees("ContractField", p.fields.items!, "contract.ts", "ContractField");
    agrees("ContractState", p.states.items!, "contract.ts", "ContractState");
    agrees("ContractAction", p.actions.items!, "contract.ts", "ContractAction");
    agrees("ContractCopy", p.copy.items!, "contract.ts", "ContractCopy");
    agrees("ContractPlanned", p.planned.items!, "contract.ts", "ContractPlanned");
  });

  it("contract copy `source` carries exactly the schema's three values", () => {
    const s = schema("@valiify/val-core/tools/design/contract.schema.json");
    const enumValues = (s.properties!.copy.items!.properties!.source.enum ?? []) as string[];
    const src = readFileSync(join(SHARED, "contract.ts"), "utf8");
    const declared = /source:\s*(.+);/.exec(src.slice(src.indexOf("export interface ContractCopy")))![1];
    for (const v of enumValues) ok(declared.includes(`"${v}"`), `ContractCopy.source lists "${v}"`);
    strictEqual(declared.split("|").length, enumValues.length, "and nothing else");
  });

  it("val.config.json — the surface block that drives the picker and the intake form", () => {
    const s = schema("@valiify/val-core/schema/val.config.schema.json");
    const surface = s.properties!.design.properties!.surfaces.additionalProperties as JsonSchema;
    agrees("DesignSurface", surface, "val-config.ts", "DesignSurface");
    agrees("BriefSchemaField", surface.properties!.briefSchema.items!, "val-config.ts", "BriefSchemaField");
    agrees("SurfaceStopTrigger", surface.properties!.stopTriggers.items!, "val-config.ts", "SurfaceStopTrigger");
    agrees("SurfaceViewport", surface.properties!.viewports.items!, "val-config.ts", "SurfaceViewport");
    agrees("DesignOutput", s.properties!.design.properties!.output, "val-config.ts", "DesignOutput");
  });
});

/**
 * A minimal draft-07 walk — required, additionalProperties:false, enum and type.
 *
 * Enough to prove a real package satisfies the contract the handoff screen assumes,
 * without pulling in a validator. handoff-check.mjs is the authority; this is a
 * tripwire on the fixture Studio's own screens are built against.
 */
function validate(value: unknown, s: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  if (s.enum && !s.enum.includes(value as never)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (s.type === "array") {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    value.forEach((v, i) => errors.push(...validate(v, s.items ?? {}, `${path}[${i}]`)));
    return errors;
  }
  if (s.type === "object" || s.properties) {
    if (typeof value !== "object" || value === null) return [`${path}: expected object`];
    const obj = value as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in obj)) errors.push(`${path}.${r}: required, missing`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = s.properties?.[k];
      if (!sub) {
        if (s.additionalProperties === false) errors.push(`${path}.${k}: not in the schema`);
        continue;
      }
      errors.push(...validate(v, sub, `${path}.${k}`));
    }
  }
  return errors;
}

const fixture = join(REPO, "val/fixtures/signed-off-run/05-package/contract.json");
const maybe = existsSync(fixture) ? describe : describe.skip;

maybe("the signed-off fixture satisfies contract.schema.json", () => {
  it("validates, so the handoff screen's seven groups are the real ones", () => {
    const s = schema("@valiify/val-core/tools/design/contract.schema.json");
    const errors = validate(JSON.parse(readFileSync(fixture, "utf8")), s);
    deepStrictEqual(errors, []);
  });
});
