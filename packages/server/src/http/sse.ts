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

const HEARTBEAT_MS = 25_000;

interface Client {
  res: ServerResponse;
  alive: boolean;
}

function write(res: ServerResponse, event: StudioEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
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
    this.heartbeat = setInterval(() => {
      const at = new Date().toISOString();
      for (const ch of this.channels.values()) {
        for (const c of ch.clients) write(c.res, { type: "heartbeat", at });
      }
      for (const c of this.globalClients) write(c.res, { type: "heartbeat", at });
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  async attach(runId: string, runDir: string, res: ServerResponse): Promise<void> {
    openStream(res);
    const client: Client = { res, alive: true };
    let ch = this.channels.get(runId);
    if (!ch) {
      const clients = new Set<Client>();
      const watcher = new RunWatcher(this.repo, runDir, runId, (e) => this.broadcast(runId, e));
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
        run: await readRunDetail(this.repo, runDir),
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
    for (const c of ch.clients) if (c.alive) write(c.res, event);
  }

  broadcastGlobal(event: StudioEvent): void {
    for (const c of this.globalClients) if (c.alive) write(c.res, event);
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
    for (const ch of this.channels.values()) ch.watcher.stop();
    this.channels.clear();
  }
}
