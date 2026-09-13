/**
 * The HTTP surface.
 *
 * Deliberately a plain node:http router with no framework: the surface is small,
 * and it is the seam a hosted runner replaces. The frontend knows these paths and
 * the shapes in @valiify/studio-shared, and nothing else about the backend.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, normalize, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import type {
  ApproveRequest,
  BriefSchemaResponse,
  CommitRunRequest,
  CreateRunRequest,
  CreateRunResponse,
  PreflightResult,
  SubmitAnswersRequest,
  SubmitAnswersResponse,
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
} from "@valiify/studio-shared";
import type { StudioConfig } from "../config.ts";
import { TargetRepoError, readTargetRepo, readValConfig, toolsDirOf } from "../target-repo.ts";
import { listRuns, readRunDetail } from "../run/reader.ts";
import { PATTERNS, RUN_FILES, numbered } from "../run/paths.ts";
import { resolveRunDir, runRoots, type RunRoot } from "../run/roots.ts";
import { RunsRootWatcher } from "../run/watcher.ts";
import { parseConcept, prepareConceptForFrame } from "../parse/concept.ts";
import { prepareRound, writeRound } from "../feedback/writer.ts";
import { runFeedbackCheck } from "../feedback/check.ts";
import { BRIEFS_DIR, expectedRunId, renderBrief, slugify, writeAnswers, writeBrief } from "../inputs.ts";
import { commitRun } from "../git.ts";
import type { DesignRunner, RunnerResult } from "../runner/types.ts";
import { RunChannels } from "./sse.ts";

const require = createRequire(import.meta.url);
const json = (res: ServerResponse, code: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
};
const fail = (res: ServerResponse, code: number, error: string, detail?: string): void =>
  json(res, code, { error, detail });

async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
}

export interface StudioServerDeps {
  config: StudioConfig;
  runner: DesignRunner;
  preflight: PreflightResult;
  version: string;
}

export function createStudioServer(deps: StudioServerDeps) {
  const { config, runner } = deps;
  const channels = new RunChannels(config.targetRepo);

  /**
   * Runs Studio itself started, so they can be stopped.
   *
   * Only these. A run someone drives from a terminal is not ours to stop, and Studio
   * has no way to reach it — which is exactly why an abandoned run is surfaced as
   * STALE rather than recorded as stopped: the run directory cannot express it, and
   * Studio does not write into the run directory to say so.
   */
  const inFlight = new Map<string, AbortController>();

  /**
   * The SDK session that last drove each run, so a clarification round can resume it.
   *
   * In memory on purpose. The session id is Studio's fact about its own process, not
   * the run's — writing it into the run directory would put Studio's bookkeeping in a
   * tree the pipeline owns. The cost is that a restart, or a run someone drove from a
   * terminal, leaves nothing to resume; the answers endpoint says so rather than
   * firing a fresh session that has never seen the questions.
   */
  const sessions = new Map<string, string>();

  /** The configured roots, re-read so a config edited underneath Studio is picked up. */
  async function roots(): Promise<RunRoot[]> {
    const { config: val } = await readValConfig(config.targetRepo);
    return runRoots(config.targetRepo, val, config.fixturesDir);
  }

  /** Resolve a runId to its directory and root, refusing anything that escapes it. */
  async function runDirOf(runId: string): Promise<{ root: RunRoot; dir: string } | null> {
    return resolveRunDir(await roots(), runId);
  }

  const rootWatcher = new RunsRootWatcher(() => {
    void (async () => {
      const { runs, errors } = await listRuns(config.targetRepo, await roots(), config.staleAfterMs);
      for (const e of errors) console.error(`[studio] ${e}`);
      channels.broadcastGlobal({ type: "runs", at: new Date().toISOString(), runs, errors });
    })().catch((err) => console.error(`[studio] run list failed: ${(err as Error).message}`));
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      // The target repo going missing or its config going unreadable is a
      // configuration failure with its own answer, not an opaque 500.
      const status = err instanceof TargetRepoError ? 502 : 500;
      const title = err instanceof TargetRepoError ? "Cannot read the target repo" : "Studio backend error";
      console.error(`[studio] ${title}: ${(err as Error).message}`);
      if (!res.headersSent) fail(res, status, title, (err as Error).message);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const seg = path.split("/").filter(Boolean); // ["api", "runs", ":id", ...]

    // A hosted frontend will not be same-origin; the dev frontend is proxied.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();

    if (seg[0] !== "api") return void fail(res, 404, "Not found");

    // ---- health & target -------------------------------------------------------
    if (path === "/api/health") {
      return void json(res, 200, {
        ok: deps.preflight.ok,
        version: deps.version,
        runner: runner.kind,
        preflight: deps.preflight,
        target: await readTargetRepo(config.targetRepo),
      });
    }
    if (path === "/api/target") {
      // Re-read every time: a surface added to val/config.json appears without a restart.
      return void json(res, 200, await readTargetRepo(config.targetRepo));
    }

    // ---- the brief schema that drives the intake form --------------------------
    if (seg[1] === "surfaces" && seg[3] === "brief-schema" && req.method === "GET") {
      const target = await readTargetRepo(config.targetRepo);
      const surface = target.surfaces.find((s) => s.id === decodeURIComponent(seg[2]));
      if (!surface) return void fail(res, 404, `No surface "${seg[2]}" in val/config.json`);
      const payload: BriefSchemaResponse = {
        surfaceId: surface.id,
        displayName: surface.displayName,
        methodologyPath: surface.methodologyPath,
        fields: surface.briefSchema ?? [],
        stopTriggers: surface.stopTriggers ?? [],
      };
      return void json(res, 200, payload);
    }

    // ---- concept.css, served for the iframe ------------------------------------
    if (path === "/api/design-asset/concept.css") {
      const { config: val } = await readValConfig(config.targetRepo);
      const local = join(config.targetRepo, toolsDirOf(val), "design", "concept.css");
      // The target repo's copy is authoritative — it is the file the concept links.
      // val-core's is the fallback for a repo whose tools dir has not been synced.
      const fallback = require.resolve("@valiify/val-core/tools/design/concept.css");
      const file = existsSync(local) ? local : fallback;
      const css = await readFile(file, "utf8");
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" });
      return void res.end(css);
    }

    // ---- runs ------------------------------------------------------------------
    if (path === "/api/runs" && req.method === "GET") {
      // `errors` travels with the list: an unreadable runs root must not look like
      // "no runs yet".
      return void json(res, 200, await listRuns(config.targetRepo, await roots(), config.staleAfterMs));
    }

    if (path === "/api/events") return void channels.attachGlobal(res);

    if (path === "/api/runs" && req.method === "POST") return void (await createRun(req, res));

    if (seg[1] === "runs" && seg[2]) {
      const runId = decodeURIComponent(seg[2]);
      const rest = seg.slice(3);

      const found = await runDirOf(runId);
      if (!found) return void fail(res, 404, `No run "${runId}"`);
      const { root, dir } = found;

      /** A fixture is a committed record in someone else's repo: never written to. */
      const refuseWrite = (): boolean => {
        if (!root.readOnly) return false;
        fail(
          res,
          403,
          `"${runId}" is a read-only reference run`,
          `It lives under ${root.relDir}/, which Studio opens for reading only. A fixture is a committed record — writing a feedback round, an answers file or an approval into one would leave an unexplained diff in the target repo. Start a run under the live runs directory instead.`,
        );
        return true;
      };

      if (rest[0] === "events") {
        return void (await channels.attach(runId, dir, res, root));
      }

      if (!rest.length && req.method === "GET") {
        return void json(res, 200, await readRunDetail(config.targetRepo, dir, root, config.staleAfterMs));
      }

      // The concept, prepared for the iframe: stylesheet repointed, overlay bridge added.
      if (rest[0] === "concept" && req.method === "GET") {
        const versions = await numbered(join(dir, RUN_FILES.conceptDir), PATTERNS.concept);
        const want = rest[1] ? Number(rest[1]) : versions.at(-1)?.n;
        const hit = versions.find((v) => v.n === want);
        if (!hit) return void fail(res, 404, `No concept.v${rest[1] ?? "<n>"}.html in this run`);
        const html = await readFile(join(dir, RUN_FILES.conceptDir, hit.name), "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
        return void res.end(prepareConceptForFrame(html, "/api/design-asset/concept.css"));
      }

      // The parsed concept: what the overlay is keyed by.
      if (rest[0] === "concept-blocks" && req.method === "GET") {
        const versions = await numbered(join(dir, RUN_FILES.conceptDir), PATTERNS.concept);
        const want = rest[1] ? Number(rest[1]) : versions.at(-1)?.n;
        const hit = versions.find((v) => v.n === want);
        if (!hit) return void fail(res, 404, "No such concept version");
        const html = await readFile(join(dir, RUN_FILES.conceptDir, hit.name), "utf8");
        return void json(res, 200, parseConcept(html, hit.n, hit.name));
      }

      // Any file inside the run dir, for rendering concept.md / critiques / HANDOFF.md.
      if (rest[0] === "file" && req.method === "GET") {
        const rel = url.searchParams.get("path") ?? "";
        const abs = resolve(dir, normalize(rel));
        if (relative(dir, abs).startsWith("..")) return void fail(res, 400, "Path escapes the run directory");
        if (!existsSync(abs)) return void fail(res, 404, `No ${rel} in this run`);
        const text = await readFile(abs, "utf8");
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return void res.end(text);
      }

      if (rest[0] === "answers" && req.method === "POST") {
        if (refuseWrite()) return;
        const payload = await body<SubmitAnswersRequest>(req);
        if (!payload.answers?.length) return void fail(res, 400, "No answers supplied");
        // Verbatim — this is what the pipeline re-reads.
        const written = await writeAnswers(dir, payload.answers, payload.note);
        const resumed = await resumeWithAnswers(runId, dir, written.relPath);
        const response: SubmitAnswersResponse = {
          ...written,
          ...resumed,
          run: await readRunDetail(config.targetRepo, dir, root, config.staleAfterMs),
        };
        // 202 when the pipeline is running again; 200 when the file landed and nothing
        // is driving it, which the client renders rather than reporting plain success.
        return void json(res, resumed.resumed ? 202 : 200, response);
      }

      if (rest[0] === "feedback" && req.method === "POST") {
        if (refuseWrite()) return;
        return void (await submitFeedback(req, res, runId, dir, root));
      }

      if (rest[0] === "approve" && req.method === "POST") {
        if (refuseWrite()) return;
        return void (await approve(req, res, runId, dir));
      }

      if (rest[0] === "stop" && req.method === "POST") {
        const ctl = inFlight.get(runId);
        if (!ctl) {
          return void json(res, 409, {
            stopped: false,
            reason:
              "Studio is not driving this run. A run started from a terminal belongs to that session; Studio can only report it as stale, never stop it.",
          });
        }
        ctl.abort();
        inFlight.delete(runId);
        channels.lifecycle(runId, "stopped", { error: "stopped by the operator" });
        return void json(res, 200, { stopped: true });
      }

      if (rest[0] === "commit" && req.method === "POST") {
        if (refuseWrite()) return;
        const payload = await body<CommitRunRequest>(req);
        const detail = await readRunDetail(config.targetRepo, dir, root, config.staleAfterMs);
        // commitRun refuses anything that is not signed-off; the stage comes from
        // the run directory, so this cannot be talked into committing early.
        const result = await commitRun(config.targetRepo, dir, detail.stage, payload.message);
        return void json(res, result.committed ? 200 : 409, result);
      }
    }

    return void fail(res, 404, "Not found");
  }

  /**
   * Hand the answers back to the pipeline.
   *
   * Gate 1 END ITS TURN at `awaiting-requester`, so the session that asked the
   * questions is over, and `/design` has no resume entry point — `/design <brief>` and
   * `/design build <run-dir>` are the only two. Resuming the SDK session restores the
   * orchestrator's own Clarification-protocol context, which is what makes its step 4
   * ("re-invoke the stage that asked") still apply.
   *
   * With no session to resume, this REFUSES rather than starting a fresh `/design`:
   * a new session has never seen the questions, and Gate 0 is not documented for a run
   * directory that already exists. Saying so beats a second silent no-op.
   */
  async function resumeWithAnswers(
    runId: string,
    dir: string,
    answersRelPath: string,
  ): Promise<{ resumed: boolean; reason?: string }> {
    const session = sessions.get(runId);
    if (!session) {
      return {
        resumed: false,
        reason:
          `The answers are saved to ${answersRelPath}, but Studio has no session to hand them to. ` +
          `A clarification round is resumed by resuming the session that asked the questions, and that session ` +
          `belongs to the Studio process that started the run — it is lost on restart, and never exists for a run ` +
          `driven from a terminal. /design has no resume entry point to fall back on, so re-running it would start ` +
          `a session that has never seen the questions. Continue this run from the terminal that started it, or ` +
          `re-run /design from Studio.`,
      };
    }
    if (inFlight.has(runId)) {
      return { resumed: false, reason: "A session is already driving this run; wait for it to finish." };
    }

    const prompt =
      `The requester has answered the blocking questions. Their answers are saved verbatim at ` +
      `${answersRelPath} in ${relative(config.targetRepo, dir)}.\n\n` +
      `Continue from the Clarification protocol: clear the pause and proceed from the gate that raised them.`;

    const ctl = new AbortController();
    inFlight.set(runId, ctl);
    channels.lifecycle(runId, "started", { command: `resume ${session} — ${answersRelPath}` });
    void runner
      .design({
        prompt,
        // Same bounds as the original run: Gate 0 named the directory, not Studio.
        ctx: {
          targetRepo: config.targetRepo,
          runDir: dir,
          runRelPath: relative(config.targetRepo, dir),
          runId,
          writeRoots: [resolve(config.targetRepo, (await roots())[0].relDir), resolve(config.targetRepo, BRIEFS_DIR)],
        },
        resume: session,
        onSession: (id) => sessions.set(runId, id),
        onProgress: (p) => channels.progress(runId, p),
        signal: ctl.signal,
      })
      .then((r) => finish(runId, prompt, r))
      .catch((e) => {
        inFlight.delete(runId);
        channels.lifecycle(runId, "failed", { command: prompt, error: (e as Error).message });
      });

    return { resumed: true };
  }

  /**
   * Report how a run ended — and what it cost, which is never small. A policy refusal
   * is reported too: a run hobbled by confinement looks exactly like a slow one.
   */
  function finish(runId: string, command: string, r: RunnerResult): void {
    inFlight.delete(runId);
    if (r.usage) {
      channels.progress(runId, {
        text:
          `run cost $${r.usage.costUSD.toFixed(2)} — ${r.usage.outputTokens} output, ` +
          `${r.usage.cacheReadTokens} cache-read, ${r.usage.cacheCreationTokens} cache-creation tokens ` +
          `(${r.usage.models.join(", ")})`,
        tokens: { input: r.usage.inputTokens, output: r.usage.outputTokens },
      });
    }
    for (const refusal of r.refusals ?? []) {
      channels.progress(runId, { text: `policy refused ${refusal.tool}: ${refusal.reason}` });
    }
    channels.lifecycle(runId, r.ok ? "finished" : "failed", { command, error: r.error });
  }

  // ---- handlers ----------------------------------------------------------------

  async function createRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = await body<CreateRunRequest>(req);
    const target = await readTargetRepo(config.targetRepo);
    const surface = target.surfaces.find((s) => s.id === payload.surfaceId);
    if (!surface) return void fail(res, 400, `No surface "${payload.surfaceId}" in val/config.json`);
    if (!surface.methodologyExists) {
      return void fail(
        res,
        409,
        `The methodology file ${surface.methodologyPath} is missing. /design stops at Gate 0 without it.`,
      );
    }
    const slug = slugify(payload.slug || "untitled");
    const markdown = renderBrief(slug, surface.id, surface.methodologyPath, surface.briefSchema ?? [], payload.sections ?? []);
    const brief = await writeBrief(config.targetRepo, slug, markdown);

    // Slash commands are processed in the PROMPT STREAM — this is prompt text.
    const prompt = `/design ${brief.relPath} --surface ${surface.id}`;
    const runId = expectedRunId(slug);
    const runRelPath = join(target.runOutputDir, runId);

    // Gate 0 names the run directory, not Studio, so a design run's writes are bounded
    // by the runs root plus the briefs directory rather than by one run directory.
    const writeRoots = [
      resolve(config.targetRepo, target.runOutputDir),
      resolve(config.targetRepo, BRIEFS_DIR),
    ];

    // Fire and forget: the run's progress reaches the client over SSE, sourced from
    // the run directory. Gate 0 — including manifest.json — belongs to the pipeline.
    const ctl = new AbortController();
    inFlight.set(runId, ctl);
    channels.lifecycle(runId, "started", { command: prompt });
    void runner
      .design({
        prompt,
        ctx: { targetRepo: config.targetRepo, runDir: join(config.targetRepo, runRelPath), runRelPath, runId, writeRoots },
        onSession: (id) => sessions.set(runId, id),
        onProgress: (p) => channels.progress(runId, p),
        signal: ctl.signal,
      })
      .then((r) => finish(runId, prompt, r))
      .catch((e) => {
        inFlight.delete(runId);
        channels.lifecycle(runId, "failed", { command: prompt, error: (e as Error).message });
      });

    const dir = join(config.targetRepo, runRelPath);
    const response: CreateRunResponse = {
      runId,
      relPath: runRelPath,
      briefPath: brief.relPath,
      prompt,
      run: existsSync(dir) ? await readRunDetail(config.targetRepo, dir, undefined, config.staleAfterMs) : null,
    };
    json(res, 202, response);
  }

  async function submitFeedback(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
    dir: string,
    root: RunRoot,
  ): Promise<void> {
    const payload = await body<SubmitFeedbackRequest>(req);
    const { config: val } = await readValConfig(config.targetRepo);
    let prepared;
    try {
      // The pin comes from the client — the concept it actually rendered.
      prepared = await prepareRound(dir, payload);
    } catch (err) {
      return void fail(res, 400, (err as Error).message);
    }

    await writeRound(prepared);
    const validation = await runFeedbackCheck(config.targetRepo, val, dir, { feedback: prepared.relPath });
    const accepted = validation.report?.verdict === "PASS";

    if (!accepted || payload.dryRun) {
      // Never leave a rejected (or rehearsed) round on disk: the orchestrator picks
      // the highest-numbered feedback file, and a rejected one would be chosen next.
      await (await import("node:fs/promises")).rm(prepared.absPath, { force: true });
    }

    const response: SubmitFeedbackResponse = {
      path: prepared.relPath,
      round: prepared.round.round,
      validation,
      accepted: accepted && !payload.dryRun,
      run: await readRunDetail(config.targetRepo, dir, root, config.staleAfterMs),
    };
    json(res, accepted ? 200 : 422, response);
  }

  async function approve(req: IncomingMessage, res: ServerResponse, runId: string, dir: string): Promise<void> {
    const payload = await body<ApproveRequest>(req);
    const detail = await readRunDetail(config.targetRepo, dir, undefined, config.staleAfterMs);
    const target = await readTargetRepo(config.targetRepo);

    const runRelPath = relative(config.targetRepo, dir);

    // Invoking /design build IS the approval. Studio does not write 04-approval.md
    // and does not compute the sha256 — Gate 4b does both.
    const prompt = `/design build ${runRelPath}\n\n${payload.message ?? ""}`.trim();
    // A build knows its run directory exactly, so it is confined to that one.
    const ctl = new AbortController();
    inFlight.set(runId, ctl);
    channels.lifecycle(runId, "started", { command: prompt });
    void runner
      .build({
        prompt,
        ctx: { targetRepo: config.targetRepo, runDir: dir, runRelPath, runId, writeRoots: [dir] },
        onSession: (id) => sessions.set(runId, id),
        onProgress: (p) => channels.progress(runId, p),
        signal: ctl.signal,
      })
      .then((r) => finish(runId, prompt, r))
      .catch((e) => {
        inFlight.delete(runId);
        channels.lifecycle(runId, "failed", { command: prompt, error: (e as Error).message });
      });

    json(res, 202, { runId, prompt, stage: detail.stage, runOutputDir: target.runOutputDir });
  }

  return {
    listen: async (port: number, host: string) => {
      await rootWatcher.start(await roots());
      // A listen failure must reject, not surface as an unhandled 'error' event.
      await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolvePromise();
        });
      });
    },
    close: () => {
      for (const [runId, ctl] of inFlight) {
        ctl.abort();
        channels.lifecycle(runId, "stopped", { error: "the Studio backend shut down" });
      }
      inFlight.clear();
      rootWatcher.stop();
      channels.close();
      server.close();
    },
    channels,
  };
}
