/**
 * Run the backend and the frontend together. Zero dependencies on purpose.
 *
 * Usage: npm run dev -- --target '<path to the library repo>'
 *
 * Frontend on :4316, backend on :4317 with /api proxied. Every other flag is passed
 * through to the backend: --port, --host, --runner stub|agent-sdk, --fixtures <dir>.
 * Quote the target — the working one contains spaces.
 */
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const target = args.includes("--target") ? args[args.indexOf("--target") + 1] : process.env.VAL_STUDIO_TARGET_REPO;
if (!target) {
  console.error("Usage: npm run dev -- --target '<path to the library repo>'");
  process.exit(1);
}

const children = [
  spawn("npm", ["run", "dev", "-w", "@valiify/studio-server", "--", "--target", target, ...args.filter((a) => a !== "--target" && a !== target)], { stdio: "inherit" }),
  spawn("npm", ["run", "dev", "-w", "@valiify/studio-web"], { stdio: "inherit" }),
];

const stop = () => children.forEach((c) => c.kill("SIGTERM"));
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
for (const c of children) c.on("exit", (code) => { if (code) { stop(); process.exit(code ?? 1); } });
