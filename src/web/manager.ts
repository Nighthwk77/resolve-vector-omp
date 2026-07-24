/**
 * Web bridge sidecar lifecycle (extension side): lazy start, single reuse,
 * health checks, stale PID/port recovery, clean shutdown. The old RV bridge
 * owns port 3030; RV-OMP defaults to 3037 and walks upward on conflict.
 * Never trusts a live socket blindly — /health must identify our bridge.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const FIRST_PORT = 3037;
const LAST_PORT = 3044;
const START_TIMEOUT_MS = 15_000;

export interface BridgeState {
  pid: number;
  port: number;
  startedAt: string;
}

export interface BridgeStatus {
  running: boolean;
  port?: number;
  providers?: string[];
  error?: string;
}

export interface StateDetection {
  state: "ready_authenticated" | "ready_anonymous" | "login_required" | "blocked" | "broken";
  kind?: string;
  detail?: string;
  popupClicks: number;
}

export interface ConsultResult {
  ok: boolean;
  text?: string;
  error?: string;
  category?: string;
  popupClicks: number;
  retries: number;
  sessionState?: StateDetection["state"];
}

async function httpJson<T>(port: number, path: string, body?: unknown, timeoutMs = 5000): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok && !("ok" in payload)) throw new Error(payload.error ?? `bridge HTTP ${response.status}`);
  return payload;
}

function statePath(agentDir: string): string {
  return join(agentDir, "rv-web-bridge.json");
}

async function readState(agentDir: string): Promise<BridgeState | undefined> {
  try {
    return JSON.parse(await readFile(statePath(agentDir), "utf8")) as BridgeState;
  } catch {
    return undefined;
  }
}

async function healthyOn(port: number): Promise<BridgeStatus> {
  try {
    const health = await httpJson<{ ok?: boolean; bridge?: string; providers?: string[]; pid?: number }>(port, "/health", undefined, 1200);
    if (health.bridge === "rv-web-bridge") return { running: true, port, providers: health.providers };
    return { running: false, error: `port ${port} answers but is not the RV web bridge` };
  } catch (error) {
    return { running: false, error: (error as Error).message };
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeState(agentDir: string, state: BridgeState): Promise<void> {
  await mkdir(dirname(statePath(agentDir)), { recursive: true });
  await writeFile(statePath(agentDir), JSON.stringify(state), "utf8");
}

export class WebBridgeManager {
  private ensureInFlight?: Promise<BridgeStatus>;

  constructor(
    private readonly agentDir: string,
    private readonly bridgeEntryPath: string,
  ) {}

  /** Health of the recorded bridge (if any). Never throws. */
  async status(): Promise<BridgeStatus> {
    const state = await readState(this.agentDir);
    if (!state) return { running: false, error: "no bridge state recorded" };
    const health = await healthyOn(state.port);
    if (health.running) return health;
    return { running: false, error: health.error };
  }

  /**
   * One bridge, exactly-once startup even under concurrent callers:
   * recorded state → health check → stale cleanup → spawn → wait for health.
   */
  async ensure(): Promise<BridgeStatus> {
    this.ensureInFlight ??= this.ensureInner().finally(() => {
      this.ensureInFlight = undefined;
    });
    return this.ensureInFlight;
  }

  private async ensureInner(): Promise<BridgeStatus> {
    const state = await readState(this.agentDir);
    if (state) {
      const health = await healthyOn(state.port);
      if (health.running) return health;
      // Stale: dead process or squatted port. Clean up before respawning.
      if (pidAlive(state.pid)) {
        try {
          process.kill(state.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
    const port = await this.findPort();
    const child = spawn(process.execPath, [this.bridgeEntryPath, "--port", String(port)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const started = Date.now();
    while (Date.now() - started < START_TIMEOUT_MS) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 250);
      await promise;
      const health = await healthyOn(port);
      if (health.running) {
        await writeState(this.agentDir, { pid: child.pid ?? 0, port, startedAt: new Date().toISOString() });
        return health;
      }
    }
    throw new Error(`web bridge did not become healthy on port ${port} within ${START_TIMEOUT_MS}ms`);
  }

  /** First free port in our range; a port answering with a foreign service is skipped, never disturbed. */
  private async findPort(): Promise<number> {
    for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
      try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) });
        continue; // something answers — leave it alone
      } catch {
        return port; // nothing there
      }
    }
    throw new Error(`no free bridge port in ${FIRST_PORT}-${LAST_PORT}`);
  }

  async detectState(app: string, timeoutMs = 30_000): Promise<StateDetection & { app: string }> {
    await this.ensure();
    const state = await readState(this.agentDir);
    if (!state) throw new Error("web bridge unavailable");
    const result = await httpJson<StateDetection & { app: string; error?: string }>(state.port, "/state", { app }, timeoutMs);
    if ("error" in result && result.error) throw new Error(result.error);
    return result;
  }

  async consult(app: string, prompt: string, timeoutMs = 180_000): Promise<ConsultResult> {
    await this.ensure();
    const state = await readState(this.agentDir);
    if (!state) throw new Error("web bridge unavailable");
    return httpJson<ConsultResult>(state.port, "/consult", { app, prompt, timeoutMs }, timeoutMs + 10_000);
  }

  async shutdown(): Promise<void> {
    const state = await readState(this.agentDir);
    if (!state) return;
    try {
      await httpJson(state.port, "/shutdown", {}, 2000);
    } catch {
      if (pidAlive(state.pid)) {
        try {
          process.kill(state.pid, "SIGTERM");
        } catch {
          /* gone */
        }
      }
    }
  }
}
