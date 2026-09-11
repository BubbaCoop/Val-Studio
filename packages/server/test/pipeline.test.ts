/**
 * Tests against the REAL target repo and the REAL val-core tools.
 *
 * There is no mock run directory here on purpose: the shapes Studio parses are
 * written by agents, and the only way to know a parser is right is to point it at
 * files agents actually wrote. The feedback test round-trips through val-core's own
 * feedback-check.mjs, because "Studio's writer satisfies the validator" is the one
 * claim that cannot be made by inspection.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readRunDetail } from "../src/run/reader.ts";
import { deriveStage } from "../src/run/stage.ts";
import { parseConcept, prepareConceptForFrame } from "../src/parse/concept.ts";
import { parseOpenQuestions, parseClarificationBlock } from "../src/parse/clarification.ts";
import { prepareRound, renderFeedback, writeRound } from "../src/feedback/writer.ts";
import { runFeedbackCheck } from "../src/feedback/check.ts";
import { readTargetRepo, readValConfig } from "../src/target-repo.ts";
import { renderBrief } from "../src/inputs.ts";
import { commitAllowed } from "../src/git.ts";

const REPO = process.env.VAL_STUDIO_TARGET_REPO ?? "/Users/nicholascooper/Desktop/valiify shortapp library";
const SIGNED_OFF = join(REPO, "val/fixtures/signed-off-run");
const BLOCKED = join(REPO, "val/fixtures/blocked-brief");
const hasRepo = existsSync(SIGNED_OFF);
const maybe = hasRepo ? describe : describe.skip;

maybe("val/config.json drives the surface list", () => {
  it("never hardcodes surfaces — it reads design.surfaces", async () => {
    const target = await readTargetRepo(REPO);
    const ids = target.surfaces.map((s) => s.id).sort();
    deepStrictEqual(ids, ["applicant-portal", "short-app"]);
    for (const s of target.surfaces) {
      ok(s.briefSchema?.length, `${s.id} has a briefSchema to generate a form from`);
      ok(s.methodologyExists, `${s.id}'s methodology file exists (a Gate 0 stop if not)`);
    }
  });

  it("renders the intake form's headings in briefSchema order", async () => {
    const target = await readTargetRepo(REPO);
    const surface = target.surfaces.find((s) => s.id === "short-app")!;
    const md = renderBrief("x", surface.id, surface.methodologyPath, surface.briefSchema!, [
      { heading: "Flow", body: "business" },
    ]);
    const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]).slice(1);
    deepStrictEqual(headings, surface.briefSchema!.map((f) => f.heading));
    ok(md.includes("business"), "supplied section body is carried through");
    ok(md.includes("_(not supplied)_"), "an empty required heading is emitted, not dropped");
  });
});

maybe("reading a signed-off run", () => {
  it("derives the stage from the directory, not the manifest alone", async () => {
    const d = await readRunDetail(REPO, SIGNED_OFF);
    strictEqual(d.stage, "signed-off");
    strictEqual(d.conceptVersions, 2);
    strictEqual(d.contract?.blocks.length, 13);
    strictEqual(d.copy.length, 21);
  });

  it("re-checks the sealed hash it never computed", async () => {
    const d = await readRunDetail(REPO, SIGNED_OFF);
    strictEqual(d.approvalHashValid, true, "the sealed concept still hashes to the approval");
    strictEqual(d.approval?.concept, "concept.v2.html");
  });

  it("parses both verdict spellings the pipeline writes in practice", async () => {
    // The fixtures use `**VERDICT: FAIL**`; the methodology documents `CRITIQUE: FAIL | …`.
    const d = await readRunDetail(REPO, SIGNED_OFF);
    deepStrictEqual(d.critiques.map((c) => c.verdict), ["FAIL", "PASS"]);
    strictEqual(d.critiques[0].blocking, 1);
    strictEqual(d.verifications[0]?.verdict, "PASS");
  });

  it("surfaces the critic cap and never presents feedback as capped", async () => {
    const d = await readRunDetail(REPO, SIGNED_OFF);
    strictEqual(d.loops.criticCap, 3);
    strictEqual(d.loops.feedback, 0, "absent from this manifest entirely; defaults to 0");
    ok(!("feedbackCap" in d.loops), "there is no feedback cap to show");
  });

  it("offers a commit only at signed-off", () => {
    ok(commitAllowed("signed-off"));
    for (const s of ["concept", "critique", "awaiting-approval", "approved", "build", "verified"] as const) {
      ok(!commitAllowed(s), `${s} is an intermediate gate — never committed`);
    }
  });
});

maybe("a BRIEF: BLOCKED run", () => {
  it("parses each question into its structured shape", async () => {
    const d = await readRunDetail(REPO, BLOCKED);
    strictEqual(d.stage, "blocked-brief");
    const qs = d.clarifications[0].questions;
    strictEqual(qs.length, 2);
    ok(qs.every((q) => q.blocking), "every stop-trigger question is BLOCKING");
    strictEqual(qs[0].trigger, "archetype-not-in-§2");
    strictEqual(qs[1].trigger, "§13-open-item");
    for (const q of qs) {
      ok(q.question && q.neededFor && q.costOfGuessing && q.acceptableAnswer, "the shape is complete");
      ok(q.raw.includes("Q:"), "the unparsed block is kept for verbatim fallback");
    }
  });

  it("keeps ROUTE: on a refusal — the only part that says how to make the ask legal", () => {
    const raw = [
      "Q: Can the name row use a 1.5px stroke?",
      "TRIGGER: §13-open-item",
      "NEEDED-FOR: b05",
      "CHECKED: short-app.md §12, §13",
      "COST-OF-GUESSING: invents a stroke the library has never shipped",
      "ROUTE: add a §12 planned addition with an interim class, or record a §13 open item.",
      "   The edit is made in design-methodology/short-app.md and committed to git, not through this UI.",
      "ACCEPTABLE-ANSWER: drop the ask, accept the determined composition, or change the methodology first",
    ].join("\n");
    const q = parseClarificationBlock(raw, true)!;
    ok(q.route?.includes("§12 planned addition"));
    ok(q.route?.includes("committed to git"), "the route says where the edit belongs");
    strictEqual(q.trigger, "§13-open-item");
  });
});

maybe("the concept contract", () => {
  it("reads blocks, nesting, viewports and copy from the drawing", async () => {
    const html = await readFile(join(SIGNED_OFF, "02-concept/concept.v2.html"), "utf8");
    const doc = parseConcept(html, 2, "concept.v2.html");
    deepStrictEqual(doc.viewports.map((v) => v.id), ["web", "mobile"]);
    const web = doc.blocks.filter((b) => b.viewport === "web");
    strictEqual(web.length, 12);
    const b13 = web.find((b) => b.id === "b13")!;
    strictEqual(b13.parent, "b02", "nested blocks keep their parent");
    const b01 = web.find((b) => b.id === "b01")!;
    strictEqual(b01.region, "header");
    strictEqual(b01.archetype, "form");
    ok(b01.classes.includes(".header"), "component classes keep their leading dot");
    ok(b01.methodology.includes("§1.1"));
    ok(doc.copyIds.includes("c01"));
    ok(b01.labels.length, "visible label text is available to the composer");
  });

  it("repoints the stylesheet and injects the overlay bridge for the iframe", async () => {
    const html = await readFile(join(SIGNED_OFF, "02-concept/concept.v2.html"), "utf8");
    const framed = prepareConceptForFrame(html, "/api/design-asset/concept.css");
    ok(framed.includes('href="/api/design-asset/concept.css"'));
    ok(!framed.includes("../../../tools/design/concept.css"), "the run-relative path is gone");
    ok(framed.includes("val-studio-concept"), "the bridge posts geometry to the parent");
    // The drawing itself must be untouched: no class attributes introduced.
    strictEqual(/\sclass\s*=/.test(framed.replace(/<script[\s\S]*?<\/script>/g, "")), false);
  });
});

maybe("a feedback round must satisfy val-core's own validator", () => {
  const temps: string[] = [];
  after(async () => {
    for (const t of temps) await rm(t, { recursive: true, force: true });
  });

  /** A scratch copy of a real run, inside the repo so the tool's report can land beside it. */
  async function scratchRun(from: string): Promise<string> {
    const dir = await mkdtemp(join(REPO, "val/runs/studio-test-"));
    temps.push(dir);
    await cp(from, dir, { recursive: true });
    return dir;
  }

  it("writes a round the real feedback-check.mjs accepts", async () => {
    const dir = await scratchRun(SIGNED_OFF);
    const { config } = await readValConfig(REPO);
    const prepared = await prepareRound(dir, {
      // Pinned to the concept that was rendered — v2 is current here.
      concept: "concept.v2.html",
      findings: [
        { id: "H1", block: "b05", severity: "blocking", rule: "", finding: "name row reads cramped", fix: "map to the §11 two-up recipe" },
        { id: "H2", block: "c02", severity: "advisory", rule: "", finding: "title reads cold", fix: "soften to second person" },
      ],
    });
    await writeRound(prepared);
    const v = await runFeedbackCheck(REPO, config, dir, { feedback: prepared.relPath });
    strictEqual(v.report?.verdict, "PASS", `feedback-check said: ${v.stdout}`);
    strictEqual(v.report?.counts.blocking, 1);
    strictEqual(v.report?.counts.advisory, 1);
    strictEqual(v.staleConceptPin, false);
  });

  it("is rejected — not silently applied — when the pin is stale", async () => {
    const dir = await scratchRun(SIGNED_OFF);
    const { config } = await readValConfig(REPO);
    // v1 was superseded by v2. Block ids are stable, so without the pin this round
    // would apply cleanly to v2 with nothing to show it had happened.
    const prepared = await prepareRound(dir, {
      concept: "concept.v1.html",
      findings: [{ id: "H1", block: "b05", severity: "blocking", rule: "", finding: "stale", fix: "re-render" }],
    });
    await writeRound(prepared);
    const v = await runFeedbackCheck(REPO, config, dir, { feedback: prepared.relPath });
    strictEqual(v.report?.verdict, "FAIL");
    strictEqual(v.staleConceptPin, true, "the UI must re-render and re-confirm, not remap the findings");
  });

  it("is rejected when a target does not exist in the pinned concept", async () => {
    const dir = await scratchRun(SIGNED_OFF);
    const { config } = await readValConfig(REPO);
    const prepared = await prepareRound(dir, {
      concept: "concept.v2.html",
      findings: [{ id: "H1", block: "b99", severity: "blocking", rule: "", finding: "no such block", fix: "x" }],
    });
    await writeRound(prepared);
    const v = await runFeedbackCheck(REPO, config, dir, { feedback: prepared.relPath });
    strictEqual(v.report?.verdict, "FAIL");
    ok(v.report?.findings.some((f) => f.check === "targets"));
    strictEqual(v.staleConceptPin, false, "a bad id is not the same failure as a stale pin");
  });

  it("refuses to write a round with no pin, and renumbers ids to H<n>", async () => {
    const dir = await scratchRun(SIGNED_OFF);
    await prepareRound(dir, { concept: "", findings: [] }).then(
      () => ok(false, "should have thrown"),
      (e: Error) => ok(/pin the concept version/.test(e.message)),
    );
    const prepared = await prepareRound(dir, {
      concept: "concept.v2.html",
      findings: [{ id: "oops", block: "-", severity: "advisory", rule: "", finding: "page-wide", fix: "do the thing" }],
    });
    strictEqual(prepared.round.findings[0].id, "H1", "H for human; the critic uses F");
    ok(prepared.markdown.includes("Concept: concept.v2.html"));
  });

  it("escapes a pipe so a typed `|` cannot shift the validator's columns", () => {
    const md = renderFeedback({
      round: 1,
      concept: "concept.v1.html",
      findings: [{ id: "H1", block: "-", severity: "advisory", rule: "", finding: "use a | here", fix: "and | here" }],
    });
    const row = md.split("\n").find((l) => l.startsWith("| H1"))!;
    strictEqual(row.split("|").length - 2, 6, "still exactly six cells");
  });
});

describe("stage derivation is file-driven", () => {
  const base = {
    manifest: null,
    hasBrief: false,
    briefBlocked: false,
    conceptCount: 0,
    critiqueCount: 0,
    hasApproval: false,
    hasPackage: false,
    verifyPassed: false,
    hasWriteup: false,
  };

  it("reports a CLI-driven run's stage with no manifest at all", () => {
    strictEqual(deriveStage({ ...base }).stage, "setup");
    strictEqual(deriveStage({ ...base, hasBrief: true }).stage, "intake");
    strictEqual(deriveStage({ ...base, hasBrief: true, conceptCount: 1 }).stage, "concept");
    strictEqual(deriveStage({ ...base, hasBrief: true, conceptCount: 1, critiqueCount: 1 }).stage, "critique");
    strictEqual(deriveStage({ ...base, hasApproval: true }).stage, "approved");
    strictEqual(deriveStage({ ...base, hasPackage: true }).stage, "build");
    strictEqual(deriveStage({ ...base, hasPackage: true, verifyPassed: true }).stage, "verified");
    strictEqual(deriveStage({ ...base, hasWriteup: true }).stage, "signed-off");
  });

  it("lets only the manifest express awaiting-approval, which no file implies", () => {
    const m = { kind: "design", runId: "r", status: "awaiting-approval" };
    strictEqual(deriveStage({ ...base, hasBrief: true, conceptCount: 2, manifest: m }).stage, "awaiting-approval");
  });

  it("always names the evidence for a transition", () => {
    ok(deriveStage({ ...base, hasApproval: true }).because.includes("04-approval.md"));
  });
});
