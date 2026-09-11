/**
 * Studio backend entry point.
 *
 * Order matters: the preflight runs BEFORE the server listens, and a failure is
 * fatal. Starting a Studio pointed at a repo that was never val-inited would let a
 * run begin against general-purpose agents — agents carrying the full tool set and
 * none of the discipline — which is the exact failure /design refuses to run into.
 */
import { existsSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { readTargetRepo } from "./target-repo.ts";
import { createStudioServer } from "./http/server.ts";
import { preflightFailureMessage } from "./runner/preflight.ts";
import { StubDesignRunner } from "./runner/stub.ts";
import { AgentSdkRunner } from "./runner/agent-sdk.ts";
import type { DesignRunner } from "./runner/types.ts";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const config = loadConfig();

  if (!existsSync(config.targetRepo)) {
    console.error(`Target repo not found: ${config.targetRepo}`);
    process.exit(1);
  }

  const runner: DesignRunner =
    config.runner === "agent-sdk"
      ? new AgentSdkRunner()
      : new StubDesignRunner({
          fixture: process.env.VAL_STUDIO_STUB_FIXTURE,
          stepMs: Number(process.env.VAL_STUDIO_STUB_STEP_MS ?? 700),
        });

  const target = await readTargetRepo(config.targetRepo);
  console.log(`Valiify Studio ${VERSION}`);
  console.log(`  target   ${config.targetRepo}`);
  console.log(`  library  ${target.library.displayName ?? target.library.name} (${target.library.package ?? "no package"})`);
  console.log(`  surfaces ${target.surfaces.map((s) => s.id).join(", ") || "(none configured)"}`);
  console.log(`  runner   ${runner.kind}`);

  process.stdout.write("  preflight… ");
  const preflight = await runner.preflight(config.targetRepo);
  if (!preflight.ok) {
    console.log("FAILED\n");
    console.error(preflightFailureMessage(preflight));
    // Loud, and fatal unless explicitly disabled for a test.
    if (config.strictPreflight) process.exit(1);
    console.error("\n(continuing anyway: strict preflight disabled)\n");
  } else {
    console.log(
      `ok — ${preflight.foundAgents.length} design agents, /${preflight.foundCommands.join(", /")} (${preflight.durationMs}ms)`,
    );
  }

  const server = createStudioServer({ config, runner, preflight, version: VERSION });
  try {
    await server.listen(config.port, config.host);
  } catch (err) {
    // A port already in use arrives as an unhandled 'error' event and a stack trace,
    // which reads as a Studio crash. It is usually an earlier Studio still running,
    // and the frontend then proxies happily to THAT one — pointed at another repo.
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(
        `\nPort ${config.port} is already in use — most likely an earlier Studio backend.\n` +
          `Stop it, or start this one on another port:\n\n  --port <n>\n\n` +
          "Leaving it running is worse than it looks: the dev frontend proxies to whatever\n" +
          "answers on that port, which may be a Studio pointed at a different repo.\n",
      );
      process.exit(1);
    }
    throw err;
  }
  console.log(`\n  http://${config.host}:${config.port}\n`);

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      server.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
