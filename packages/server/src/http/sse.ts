/**
 * The SSE channel.
 *
 * One RunWatcher per run, started when the first client attaches and stopped when
 * the last one leaves. Clients receive a `snapshot` immediately, so a screen never
 * has to poll for its initial state, and then the watcher's own events.
 *
 * Every event on this channel except `agent-progress` originates in the run
 * directory. That is what makes a CLI-driven run exactly as observable here as one
 * Studio started.
 */
import type { ServerResponse } from "node:http";
import type { RunEvent, StudioEvent } from "@valiify/studio-shared";
import { RunWatcher } from "../run/watcher.ts";
import type { RunRoot } from "../run/roots.ts";

const HEARTBEAT_MS = 25_000;

interface Client {
  res: ServerResponse;
  alive: boolean;
}

/**
 * Write one event. A client that has gone away without its `close` firing — a laptop
 * that slept, a proxy that dropped the connection — would otherwise throw here and
 * take the rest of the broadcast with it, so the surviving clients silently stop
 * receiving updates. Returns false so the caller can drop the dead client.
 */
function write(res: ServerResponse, event: StudioEvent): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    return true;
  } catch (err) {
    console.warn(`[studio] dropping an SSE client: ${(err as Error).message}`);
    return false;
  }
}

export function openStream(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Nothing here is buffered by a proxy in local use, but a hosted runner will
    // sit behind one and a buffered event stream looks exactly like a frozen gate.
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
}

export class RunChannels {
  repo: string;
  private channels = new Map<string, { watcher: RunWatcher; clients: Set<Client> }>();
  private heartbeat: NodeJS.Timeout;
  /** Clients on the global channel — the run list. */
  private globalClients = new Set<Client>();

  constructor(repo: string) {
    this.repo = repo;
    // The heartbeat is also the liveness check: a client the write fails for is gone,
    // and keeping it in the set would mean broadcasting into a closed socket forever.
    this.heartbeat = setInterval(() => {
      const at = new Date().toISOString();
      for (const [runId, ch] of this.channels) {
        for (const c of ch.clients) if (!write(c.res, { type: "heartbeat", at })) this.drop(runId, c);
      }
      for (const c of this.globalClients) if (!write(c.res, { type: "heartbeat", at })) this.globalClients.delete(c);
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  async attach(runId: string, runDir: string, res: ServerResponse, root?: RunRoot): Promise<void> {
    openStream(res);
    const client: Client = { res, alive: true };
    let ch = this.channels.get(runId);
    if (!ch) {
      const clients = new Set<Client>();
      const watcher = new RunWatcher(this.repo, runDir, runId, (e) => this.broadcast(runId, e), root);
      ch = { watcher, clients };
      this.channels.set(runId, ch);
      ch.clients.add(client);
      // start() emits the initial snapshot through broadcast, reaching this client.
      await watcher.start();
    } else {
      ch.clients.add(client);
      // A late joiner gets its own snapshot rather than waiting for the next change.
      const { readRunDetail } = await import("../run/reader.ts");
      write(res, {
        type: "snapshot",
        runId,
        at: new Date().toISOString(),
        run: await readRunDetail(this.repo, runDir, root),
      });
    }

    res.on("close", () => {
      client.alive = false;
      ch!.clients.delete(client);
      if (!ch!.clients.size) {
        ch!.watcher.stop();
        this.channels.delete(runId);
      }
    });
  }

  attachGlobal(res: ServerResponse): void {
    openStream(res);
    const client: Client = { res, alive: true };
    this.globalClients.add(client);
    res.on("close", () => this.globalClients.delete(client));
  }

  broadcast(runId: string, event: RunEvent): void {
    const ch = this.channels.get(runId);
    if (!ch) return;
    for (const c of ch.clients) if (c.alive && !write(c.res, event)) this.drop(runId, c);
  }

  broadcastGlobal(event: StudioEvent): void {
    for (const c of this.globalClients) if (c.alive && !write(c.res, event)) this.globalClients.delete(c);
  }

  /** Forget a client whose socket is gone, and stop its watcher if it was the last. */
  private drop(runId: string, client: Client): void {
    const ch = this.channels.get(runId);
    if (!ch) return;
    client.alive = false;
    ch.clients.delete(client);
    if (!ch.clients.size) {
      ch.watcher.stop();
      this.channels.delete(runId);
    }
  }

  /** Relay token-level progress from a runner. Advisory: never a stage record. */
  progress(runId: string, p: { agent?: string; text?: string; tokens?: { input?: number; output?: number } }): void {
    this.broadcast(runId, { type: "agent-progress", runId, at: new Date().toISOString(), ...p });
  }

  lifecycle(runId: string, phase: "started" | "finished" | "failed" | "stopped", extra: { command?: string; error?: string } = {}): void {
    this.broadcast(runId, { type: "lifecycle", runId, at: new Date().toISOString(), phase, ...extra });
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const ch of this.channels.values()) {
      ch.watcher.stop();
      for (const c of ch.clients) c.res.end();
    }
    this.channels.clear();
    for (const c of this.globalClients) c.res.end();
    this.globalClients.clear();
  }
}
