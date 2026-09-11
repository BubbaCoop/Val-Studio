/**
 * Running the pipeline's own validator over every file Studio writes.
 *
 *   node <target-repo>/val/tools/design/feedback-check.mjs <run-dir> --out json
 *
 * Studio never dispatches a round the tool rejects; it surfaces the tool's own
 * failures in the UI instead. The most important check is `targets`: every block
 * the round names must exist in the concept version being addressed. A stale block
 * id means the designer is looking at a stale preview, and the correct response is
 * to RE-RENDER the current concept and ask them to re-confirm — never to guess which
 * block they meant.
 *
 * cwd is the target repo on purpose. `--out json` resolves its report path through
 * val-core's resolveReport, which refuses to write beside a target that sits outside
 * the working directory; run from anywhere else and no report file appears.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FeedbackCheckReport, FeedbackValidation, ValConfig } from "@valiify/studio-shared";
import { designToolPath } from "../target-repo.ts";
import { RUN_FILES } from "../run/paths.ts";

export function runFeedbackCheck(
  targetRepo: string,
  config: ValConfig,
  runDir: string,
  opts: { feedback?: string; concept?: string } = {},
): Promise<FeedbackValidation> {
  const tool = designToolPath(targetRepo, config, "feedback-check.mjs");
  const args = [tool, runDir, "--out", "json"];
  if (opts.feedback) args.push("--feedback", opts.feedback);
  if (opts.concept) args.push("--concept", opts.concept);

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      // Arguments are an array, never a shell string: the target repo path has spaces.
      { cwd: targetRepo, maxBuffer: 8 * 1024 * 1024 },
      async (err, stdout, stderr) => {
        const exitCode = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : 0;
        let report: FeedbackCheckReport | null = null;
        try {
          report = JSON.parse(await readFile(join(runDir, RUN_FILES.feedbackCheck), "utf8")) as FeedbackCheckReport;
        } catch {
          // No report file: the tool exits before writing when the run dir or the
          // file is missing. stdout is then the only record, and is kept verbatim.
        }
        resolve({
          report,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode,
          staleConceptPin: isStalePin(report, stdout ?? ""),
        });
      },
    );
  });
}

/**
 * Is the ONLY problem that the designer reviewed a superseded version?
 *
 * That case has a specific correct response — re-render the current concept and ask
 * them to re-confirm — which is different from every other failure, so the UI needs
 * to be able to tell them apart.
 */
function isStalePin(report: FeedbackCheckReport | null, stdout: string): boolean {
  if (report) {
    const fails = report.findings.filter((f) => f.severity === "fail");
    return fails.length > 0 && fails.every((f) => f.check === "version");
  }
  return /round pins concept\.v\d+\.html, but concept\.v\d+\.html already exists/.test(stdout);
}
