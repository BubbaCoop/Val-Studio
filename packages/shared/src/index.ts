/**
 * The wire contract between the Studio backend and the Studio frontend.
 *
 * Every type here is derived from a real file in @valiify/val-core — the config
 * schema, the contract schema, the methodology, or a tool's report shape. Nothing
 * here is invented; where a field is optional it is because the real fixtures show
 * it absent (manifest.loops.feedback, for example, is missing from a run whose
 * reviewer never sent a round).
 *
 * This package is the seam that lets a hosted runner replace the local one: the
 * frontend imports only from here, never from the server.
 */

export * from "./val-config.ts";
export * from "./manifest.ts";
export * from "./concept.ts";
export * from "./contract.ts";
export * from "./clarification.ts";
export * from "./feedback.ts";
export * from "./run.ts";
export * from "./events.ts";
export * from "./api.ts";
