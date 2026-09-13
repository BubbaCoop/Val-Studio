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
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readRunDetail, verdictOf } from "../src/run/reader.ts";
import { deriveStage } from "../src/run/stage.ts";
import { parseConcept, prepareConceptForFrame } from "../src/parse/concept.ts";
import { parseOpenQuestions, parseClarificationBlock } from "../src/parse/clarification.ts";
import { prepareRound, renderFeedback, writeRound } from "../src/feedback/writer.ts";
import { runFeedbackCheck } from "../src/feedback/check.ts";
import { readTargetRepo, readValConfig } from "../src/target-repo.ts";
import { listRuns } from "../src/run/reader.ts";
import { parseRunKey, resolveRunDir, runKey, runRoots } from "../src/run/roots.ts";
import { renderBrief, writeAnswers } from "../src/inputs.ts";
import { commitAllowed, commitRun } from "../src/git.ts";

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
    // The template specifies `CRITIQUE: FAIL | FINDINGS: n | BLOCKING: n`. The runs in
    // this repo carry that AND a prose `**VERDICT: FAIL**` opener — an upstream
    // divergence Studio reads through rather than normalises away.
    const d = await readRunDetail(REPO, SIGNED_OFF);
    deepStrictEqual(d.critiques.map((c) => c.verdict), ["FAIL", "PASS"]);
    strictEqual(d.critiques[0].findings, 10);
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

  it("refuses an intermediate-gate commit with a reason, and runs no git at all", async () => {
    const r = await commitRun(REPO, SIGNED_OFF, "awaiting-approval");
    strictEqual(r.committed, false);
    ok(r.refusedReason?.includes("signed-off"), "the refusal says where the commit action lives");
  });
});

maybe("fixtures are listed as read-only reference runs", () => {
  it("namespaces a fixture's id so it can never be confused with a live run", async () => {
    const { config } = await readValConfig(REPO);
    const roots = runRoots(REPO, config, "val/fixtures");
    deepStrictEqual(roots.map((r) => r.id), ["runs", "fixtures"]);
    strictEqual(roots[0].readOnly, false);
    strictEqual(roots[1].readOnly, true);
    strictEqual(runKey(roots[1], "signed-off-run"), "fixtures:signed-off-run");
    deepStrictEqual(parseRunKey("fixtures:signed-off-run"), { rootId: "fixtures", name: "signed-off-run" });
    // A live run keeps the bare directory name — the id `/design build` is invoked with.
    deepStrictEqual(parseRunKey("2026-09-11-design-primary-contact"), {
      rootId: "runs",
      name: "2026-09-11-design-primary-contact",
    });
  });

  it("refuses a traversal out of either root", async () => {
    const { config } = await readValConfig(REPO);
    const roots = runRoots(REPO, config, "val/fixtures");
    strictEqual(resolveRunDir(roots, "../fixtures/signed-off-run"), null);
    strictEqual(resolveRunDir(roots, "fixtures:../runs"), null);
    ok(resolveRunDir(roots, "fixtures:signed-off-run"), "the fixture itself resolves");
  });

  it("lists both roots, and marks only the fixtures read-only", async () => {
    const { config } = await readValConfig(REPO);
    const { runs, errors } = await listRuns(REPO, runRoots(REPO, config, "val/fixtures"));
    deepStrictEqual(errors, [], "both configured roots are readable");
    const fixture = runs.find((r) => r.runId === "fixtures:signed-off-run")!;
    ok(fixture, "the signed-off fixture is openable");
    strictEqual(fixture.readOnly, true);
    strictEqual(fixture.root, "fixtures");
    strictEqual(fixture.stage, "signed-off");
    for (const r of runs.filter((x) => x.root === "runs")) {
      strictEqual(r.readOnly, false, `${r.runId} is a live run`);
    }
  });

  it("reports an unreadable runs root instead of returning an empty list", async () => {
    const { config } = await readValConfig(REPO);
    const roots = runRoots(REPO, { ...config, paths: { ...config.paths, runOutputDir: "val/does-not-exist" } }, "");
    const { runs, errors } = await listRuns(REPO, roots);
    deepStrictEqual(runs, []);
    strictEqual(errors.length, 1, "\"no runs yet\" and \"cannot read the runs root\" are different answers");
    ok(errors[0].includes("val/does-not-exist"));
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

describe("the verdict line is read from the status line, not the whole document", () => {
  it("accepts both spellings the pipeline writes", () => {
    strictEqual(verdictOf("CRITIQUE: FAIL | FINDINGS: 3 | BLOCKING: 2", "CRITIQUE").verdict, "FAIL");
    strictEqual(verdictOf("**VERDICT: PASS** — zero blocking findings.", "CRITIQUE").verdict, "PASS");
    strictEqual(verdictOf("VERIFY: PASS | BLOCKING: 0", "VERIFY").verdict, "PASS");
  });

  it("takes the counts off the line that carries them", () => {
    const v = verdictOf(
      [
        "# Critique 2 — v2",
        "**VERDICT: PASS** — zero blocking findings.",
        "",
        "The previous pass reported FINDINGS: 10 | BLOCKING: 1 and is not this critique.",
        "",
        "CRITIQUE: PASS | VERSION: v2 | FINDINGS: 1 | BLOCKING: 0 | ADVISORY: 1",
      ].join("\n"),
      "CRITIQUE",
    );
    strictEqual(v.verdict, "PASS");
    // A whole-document scrape would have read the quoted line and reported 10 and 1.
    strictEqual(v.findings, 1);
    strictEqual(v.blocking, 0);
  });

  it("reports UNKNOWN rather than guessing when there is no verdict at all", () => {
    strictEqual(verdictOf("# Critique\n\nSome prose.", "CRITIQUE").verdict, "UNKNOWN");
  });
});

describe("every clarification the run directory carries is surfaced", () => {
  it("reads Gate 1, Gate 2 and a Gate 4a refusal — one shape, one component", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-clar-"));
    try {
      await mkdir(join(dir, "02-concept"), { recursive: true });
      await mkdir(join(dir, "00-input"), { recursive: true });
      await writeFile(
        join(dir, "01-brief.md"),
        ["# Brief — x", "## Open questions", "### BLOCKING", "```", "Q: Which flow?", "TRIGGER: brief-missing-field", "```", ""].join("\n"),
      );
      await writeFile(
        join(dir, "02-concept/concept.md"),
        ["# Concept", "## Open questions", "```", "Q: Which class carries the seam?", "TRIGGER: no-component", "```", ""].join("\n"),
      );
      await writeFile(
        join(dir, "00-input/questions-1.md"),
        [
          "Q: Can the name row use a 1.5px stroke?",
          "TRIGGER: §13-open-item",
          "ROUTE: add a §12 planned addition with an interim class — the edit belongs in the methodology file and git.",
          "",
        ].join("\n"),
      );

      const d = await readRunDetail(dir, dir);
      deepStrictEqual(d.clarifications.map((c) => c.origin), ["brief", "concept", "feedback"]);
      strictEqual(d.clarifications[1].gate, 2, "a blocked concept is a Gate 2 stop, not a Gate 1 one");
      const refusal = d.clarifications[2].questions[0];
      ok(refusal.route?.includes("§12 planned addition"), "the ROUTE survives — a refusal without it is a bare no");
      ok(refusal.blocking);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

maybe("the answer round-trip, against the real blocked run", () => {
  /**
   * This path had no coverage, and it showed: the handler wrote the file and never
   * handed it to the pipeline, so submitting reported success twice while the run sat
   * untouched. These pin the two halves separately — what lands on disk, and what the
   * pipeline will read back — because only the first half is Studio's to guarantee.
   */
  const temps: string[] = [];
  after(async () => {
    for (const t of temps) await rm(t, { recursive: true, force: true });
  });

  async function scratchRun(from: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "studio-answers-"));
    temps.push(dir);
    await cp(from, dir, { recursive: true });
    return dir;
  }

  it("writes answers-<n>.md verbatim, numbered, and re-readable by the reader", async () => {
    const dir = await scratchRun(BLOCKED);
    const before = await readRunDetail(dir, dir);
    const question = before.clarifications[0].questions[0];
    ok(question.blocking, "the fixture's first question is blocking");

    // A real answer: prose the requester typed, punctuation and all.
    const text = 'Out of scope — documents move to the Applicant Portal (§13). Don\'t compose this step.';
    const w1 = await writeAnswers(dir, [{ questionId: question.id!, text }]);
    strictEqual(w1.round, 1);
    strictEqual(w1.relPath, "00-input/answers-1.md");

    const saved = await readFile(join(dir, w1.relPath), "utf8");
    ok(saved.includes(text), "the requester's words are saved verbatim, not normalised");
    ok(saved.includes(`## ${question.id}`), "and attributed to the question they answer");

    // Round numbering continues rather than overwriting: intake reads every
    // answers-<n>.md and later answers override earlier text.
    const w2 = await writeAnswers(dir, [{ questionId: question.id!, text: "second thoughts" }]);
    strictEqual(w2.round, 2);
    strictEqual(w2.relPath, "00-input/answers-2.md");
    ok(existsSync(join(dir, "00-input/answers-1.md")), "the first round is never clobbered");

    // The reader sees both, in order, which is what the run screen renders.
    const after = await readRunDetail(dir, dir);
    deepStrictEqual(after.answers.map((a) => a.round), [1, 2]);
    ok(after.answers[0].text.includes(text));
    // And the questions still parse — writing answers does not disturb 01-brief.md.
    strictEqual(after.clarifications[0].questions.length, before.clarifications[0].questions.length);
    strictEqual(after.stage, "blocked-brief", "the stage only moves when a gate rewrites the run");
  });

  it("keeps each question's fields to itself — no leak across the separator", async () => {
    /*
     * The shape a real intake writes: NO fences, a bold `**Q2: …**` title, and a `---`
     * rule between questions. The tracked fixture fences its blocks and has no rules at
     * all, so asserting against the fixture could never catch this — it passed happily
     * while the bug was live. The text below is the observed format, trimmed.
     */
    const brief = [
      "# Brief — business-documents",
      "",
      "## Open questions",
      "",
      "### BLOCKING",
      "",
      "**Q1: File upload is not a supported archetype**",
      "",
      "Q: §2 lists eight archetypes and none of them is a file-upload step. How should",
      "document upload be composed on this surface?",
      "",
      "TRIGGER: `archetype-not-in-§2`",
      "",
      "NEEDED-FOR: The entire step.",
      "",
      "CHECKED: §2 Archetypes; §10 Component map.",
      "",
      "COST-OF-GUESSING: Inventing an upload slot means inventing a component.",
      "",
      'ACCEPTABLE-ANSWER: One of: (1) "out of scope", or (2) a §12 planned addition.',
      "",
      "---",
      "",
      "**Q2: Upload progress state is unspecified**",
      "",
      'Q: What should display during file upload?',
      "",
      "TRIGGER: `§13-open-item`",
      "",
      "NEEDED-FOR: The uploading state row.",
      "",
      "CHECKED: §6 State handling; §13 Open items.",
      "",
      "COST-OF-GUESSING: A spinner gives no feedback on transfer progress.",
      "",
      'ACCEPTABLE-ANSWER: A decision on what displays during upload.',
      "",
      "---",
      "",
      "### NON-BLOCKING",
      "",
      "None.",
      "",
      "## Methodology rules applied",
      "",
      "- §2 Archetypes — checked.",
      "",
    ].join("\n");

    const round = parseOpenQuestions(brief, { gate: 1, origin: "brief", source: "01-brief.md" })!;
    strictEqual(round.questions.length, 2, "two questions, not one absorbed into the other");

    const [q1, q2] = round.questions;
    // The exact leak that was live: the LAST field swallowed the rule and the next title.
    strictEqual(q1.acceptableAnswer, 'One of: (1) "out of scope", or (2) a §12 planned addition.');
    strictEqual(q2.acceptableAnswer, "A decision on what displays during upload.");
    // And the trailing rule before ### NON-BLOCKING does not ride along either.
    ok(!/-{3,}/.test(q2.acceptableAnswer!));

    for (const q of round.questions) {
      for (const field of [q.question, q.neededFor, q.checked, q.costOfGuessing, q.acceptableAnswer]) {
        if (!field) continue;
        ok(!/-{3,}/.test(field), `${q.id}: absorbed a --- separator: ${field.slice(-60)}`);
        ok(!/\*\*Q\d+/.test(field), `${q.id}: absorbed the next question's title: ${field.slice(-60)}`);
        ok(!/^#{1,6}\s/m.test(field), `${q.id}: absorbed a heading: ${field.slice(-60)}`);
      }
    }
  });

  it("still parses the fenced shape the tracked fixture uses", async () => {
    // Both formats are in the wild. Neither may regress for the other's sake.
    const dir = await scratchRun(BLOCKED);
    const d = await readRunDetail(dir, dir);
    strictEqual(d.clarifications[0].questions.length, 2);
    strictEqual(d.clarifications[0].questions[0].trigger, "archetype-not-in-§2");
  });
});
