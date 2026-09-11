# Valiify Studio

A local-first web UI for driving `@valiify/val-core`'s `/design` pipeline visually:
pick a surface, write a brief, review the grey-box concept, give per-block feedback,
approve, hand off.

## What Studio is — and the line it does not cross

Studio is a **client** for a pipeline that already exists. It authors two things and
renders everything else.

**Studio writes exactly two kinds of file:**

| file | what it is |
| --- | --- |
| `val/briefs/brief-<slug>.md` | the requester's brief, rendered from the surface's `briefSchema` |
| `<run-dir>/00-input/feedback-<n>.md` | a Gate 4a feedback round |
| `<run-dir>/00-input/answers-<n>.md` | answers to a `BRIEF: BLOCKED` round, verbatim |

**Studio never:**

- generates markup, a concept, or a Svelte component
- writes `01-brief.md` (that is `design-brief-intake`'s output) or `manifest.json` (Gate 0's)
- writes `04-approval.md` or computes the approval sha256 — Gate 4b does both
- edits a methodology file
- raises a loop cap, skips a gate, or decides that a gate passed
- normalises away a pipeline output it finds inconvenient

Everything that prevents invented style — the five stop triggers, `class-audit`, the
critic loop cap of 3, the sha256 seal — runs underneath, unchanged. **If a change
would move any of that logic into Studio, stop and ask.** The correct shape for a new
capability is almost always "read another file the pipeline already writes", not
"decide something the pipeline decides".

Two things Studio *does* do with the pipeline's own outputs, and both are re-checks,
never computations: it re-hashes the approved concept to see whether a sealed approval
is still valid, and it runs `feedback-check.mjs` over every round it writes before
offering to send it.

## The run directory is the source of truth

Every stage, loop counter and gate transition is derived from files on disk plus
`manifest.json` — never from an agent stream. The practical test: **a run driven from
the CLI is exactly as observable in Studio as one Studio started.** The only event
sourced from the Agent SDK is `agent-progress`, which carries token-level progress and
is advisory; a CLI-driven run emits every other event.

`RunSummary.runId` is the run **directory name**, not `manifest.runId`. Real repos
contain several directories whose manifests share a runId (a re-dispatch, a model
comparison), and keying on the manifest would make one run open another.

## Layout

```
packages/shared   the wire contract — types only, no runtime. The frontend imports
                  from here and never from the server, which is the seam a hosted
                  runner would replace.
packages/server   node:http + node:fs. No framework, no database, no cache.
packages/web      React + Vite + Tailwind v4. Studio's own chrome only — never built
                  from the target repo's component library.
```

- **No build step on the server.** Node runs the TypeScript directly (type stripping).
  That is why the tsconfigs set `erasableSyntaxOnly`, `verbatimModuleSyntax` and
  `rewriteRelativeImportExtensions`, and why imports carry `.ts` extensions. Needs
  Node ≥ 22.18; developed on 24.
- **No database.** The run directory and git are the only state Studio has. Nothing is
  cached: `val/config.json` is re-read on every request, so a surface added to the
  target repo appears without a restart.
- **Dependencies:** `@anthropic-ai/claude-agent-sdk` (server), React/Vite/Tailwind
  (web), TypeScript. Ask before adding anything else.

## The target repo

Studio drives a val-inited library repo on disk; it has no library of its own.

```
npm run dev -- --target '/path/to/library repo'
```

(quote it — the working target path contains spaces, and nothing in Studio is ever
interpolated into a shell string; every child process takes an argv array.)

Frontend on `:4316`, backend on `:4317`, `/api` proxied. Other flags:
`--port`, `--host`, `--runner stub|agent-sdk`, `--fixtures <dir>`,
`--strict-preflight 0` (tests only). Env equivalents:
`VAL_STUDIO_TARGET_REPO`, `VAL_STUDIO_RUNNER`, `VAL_STUDIO_FIXTURES_DIR`.

`npm test` and `npm run typecheck` run against the real target repo and the real
val-core tools — there is no mock run directory on purpose.

### How surfaces are discovered

From `val/config.json` → `design.surfaces`, and nowhere else. Studio hardcodes no
surface, no region vocabulary, no brief schema and no stop trigger. Each surface
supplies its own `briefSchema` (heading order is part of the contract — `01-brief.md`
follows it), `viewports`, `regions`, `stopTriggers` and `conceptSections`. A surface
whose methodology file is missing is shown as unstartable, because that is a Gate 0
stop.

The types in `packages/shared` mirror `val.config.schema.json` and
`tools/design/contract.schema.json` by hand, because Studio has no build step.
`packages/server/test/contracts.test.ts` checks them against those schema files in
`node_modules` — property names must match exactly, and anything Studio types as
non-optional must be `required` in the schema. Add a field to a shared type only if
the schema has it.

### Runs roots

Two, from `run/roots.ts`:

- `paths.runOutputDir` (default `val/runs`) — the live runs. Writable.
- `val/fixtures` — the target repo's tracked reference runs, listed as
  `fixtures:<name>` and **read-only**. Every write against one is refused with a 403.
  A fixture is a committed record; a feedback round or an approval written into one
  would leave an unexplained diff in someone else's repo.

## The feedback file

`00-input/feedback-<n>.md`, the format from methodology §8b — the **same table the
critic uses**, so one rework path serves both:

```
# Feedback 2
Concept: concept.v2.html

| id | block | severity | rule | finding | fix |
| H1 | b05 | blocking | §5 | first name should be a dropdown | map to .dropdown-field |
```

- ids are `H1, H2 …` (the critic's are `F1, F2 …`) so the fix ledger records who asked
- `block` is a `data-block` or copy id **from the pinned concept**, or `-` for the page
- `rule` may be empty — a designer need not cite a §
- `fix` must say what to DO; the architect acts on that column
- a typed `|` is written as `&#124;` so it cannot shift the validator's columns

**The `Concept:` pin is the load-bearing line.** Block ids are stable across versions,
so a round collected on v2 would apply cleanly to v3 and the substitution would be
invisible. Studio writes the pin from **the concept that is rendered on screen**, never
from "the latest", and refuses to write a round without one. When `feedback-check`
rejects a round for a stale pin, the correct response is to re-render the current
concept and ask the designer to re-confirm — never to remap their findings onto a
drawing they did not look at.

Feedback rounds are **uncapped** and counted separately from `loops.critic`. Studio
surfaces the critic cap and never offers to raise it; it never presents feedback rounds
as capped, not even visually.

## The preflight, and why a missing subagent is fatal

`runner/preflight.ts` opens an Agent SDK session with `cwd` set to the target repo and
`settingSources: ["user", "project", "local"]` (without those the repo's own
`.claude/agents` are never loaded and a correctly configured repo would fail), then
asks `supportedAgents()` and `supportedCommands()`. It requires all five `design-*`
subagents and `/design`, and checks that
`.claude/agents/design-concept-architect.md`'s generated header names the same library
as `val/config.json`.

A miss is **fatal at startup**. Without the five subagents the pipeline degrades to
general-purpose agents — the full tool set and none of the discipline — which is the
precise failure `/design` refuses to run into. Studio refuses to start into it either,
rather than starting degraded and looking fine. The preflight is real in every runner,
including the stub.

## cwd for val-core tools

Every val-core tool is spawned with **`cwd` set to the target repo**. `tools/lib/report.mjs`'s
`resolveReport` refuses to write a report beside a target that sits outside the working
directory — so run the tool from anywhere else and `--out json` silently writes nothing,
and the caller gets no report to parse. Currently one such spawn:
`feedback/check.ts` → `val/tools/design/feedback-check.mjs`. Any new one goes through
`designToolPath()` and keeps `cwd: targetRepo`.

## Standing rules

- **A tool's false positive is a tool bug.** If `class-audit`, `handoff-check` or
  `feedback-check` flags something that is in fact correct, fix the tool and add a test
  for the case. Never bend working library code, a methodology, or a concept to satisfy
  a check. The same applies to Studio's own parsers.
- **Nothing fails quietly.** A missing config, an unreadable run directory, a corrupt
  manifest, a dropped SSE stream, a refused write — each gets a visible banner with the
  reason. An empty screen and a broken backend must never look alike.
- **Relay verbatim.** A clarification question, a `ROUTE:` line, an approval message,
  an answer: rendered as written. A refusal without its ROUTE is a bare refusal, which
  the methodology forbids.
- **Never commit into the target repo.** The commit action is explicit, offered at
  `signed-off` only, and stages that run directory alone.

## Known upstream divergences (val-core's, not Studio's)

Studio reads through both rather than normalising them away; the fix belongs upstream.

- The critic writes two verdict formats. `design.template.md` specifies
  `CRITIQUE: PASS | FINDINGS: n | BLOCKING: n`; some runs open with a prose
  `**VERDICT: PASS** — …` and put the machine line at the bottom. `verdictOf()` accepts
  both and reads counts only from the line that carries them.
- `manifest.runId` is date-plus-slug, so re-running the same brief on the same day
  collides. Several run directories in the target repo share a runId. Studio keys on
  the directory name, so this does not affect it — but it does make `manifest.runId`
  useless as an identifier.

## Not wired

`runner/agent-sdk.ts`'s `design()` and `build()` are stubs. The preflight in it is real.
`StubDesignRunner` replays a recorded run's files into a run directory on a delay,
which is how the watcher → SSE → screen path is exercised without spending tokens; it
copies `04-approval.md` verbatim, hash included, and never computes a seal.
