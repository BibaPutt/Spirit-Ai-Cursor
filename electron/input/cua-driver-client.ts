// Cua Driver MCP-over-stdio client.
//
// The vendored cua-driver binary exposes a Model Context Protocol stdio server
// (`cua-driver mcp`, direct runtime on Windows/Linux — no separate daemon). We
// speak line-delimited JSON-RPC 2.0 over the child's stdin/stdout, the same
// framing the driver's own SDK uses. No third-party MCP SDK: this stays small
// and gives exact control over timeouts, reconnect and the child lifecycle.
//
// The child is injectable so the framing + state machine unit-test against a
// fake process (no real daemon in tests).

import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

// Negotiation order: newest first, legacy pinned version last. Modern drivers
// speak 2026-07-28 (discoverable without initialize); older vendored builds
// only know 2024-11-05. A version-mismatch rejection falls through to the
// next candidate; any other failure aborts the connect.
export const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-06-18', MCP_PROTOCOL_VERSION];

export type ToolContent = Array<{ type?: string; text?: string }>;

export type ToolResult = {
  content?: ToolContent;
  isError?: boolean;
  structuredContent?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type SpawnDriverFn = (
  exePath: string,
  args: string[],
  opts: SpawnOptions,
) => ChildProcess;

export interface CuaDriverMcpOptions {
  exePath: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  spawnFn?: SpawnDriverFn;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  onLog?: (message: string) => void;
}

export class CuaDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CuaDriverError';
  }
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: {
    protocolVersion?: string;
    message?: string;
    [key: string]: unknown;
  };
  result?: unknown;
  error?: { code?: number; message?: string };
};

const defaultSpawn: SpawnDriverFn = (exePath, args, opts) => spawn(exePath, args, opts);

// True when an initialize failure is a version negotiation rejection (worth
// retrying with an older protocol) rather than a fatal error. MCP servers
// reject unknown versions with -32602 (invalid params) or a message naming
// the protocol/version.
function isProtocolVersionMismatch(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/code -32602/.test(message)) return true;
  return /protocol|version|unsupported/i.test(message);
}

export class CuaDriverMcpClient {
  private child: ChildProcess | null = null;
  private rl: Interface | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private ready = false;
  private closed = false;
  private readonly exePath: string;
  private readonly args: string[];
  private readonly env: Record<string, string | undefined>;
  private readonly spawnFn: SpawnDriverFn;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly onLog: (message: string) => void;
  private negotiatedProtocolVersion: string | null = null;

  constructor(options: CuaDriverMcpOptions) {
    this.exePath = options.exePath;
    this.args = options.args ?? ['mcp'];
    this.env = { CUA_DRIVER_RS_TELEMETRY_ENABLED: '0', ...options.env };
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10000;
    this.onLog = options.onLog ?? (() => undefined);
  }

  get isReady(): boolean {
    return this.ready;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // Protocol version agreed during connect() (null before connect).
  get protocolVersion(): string | null {
    return this.negotiatedProtocolVersion;
  }

  get childPid(): number | null {
    return this.child?.pid ?? null;
  }

  async connect(): Promise<void> {
    if (this.ready) return;
    if (this.closed) throw new CuaDriverError('cua-driver client is closed');

    let child: ChildProcess;
    try {
      child = this.spawnFn(this.exePath, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...this.env },
      });
    } catch (err) {
      throw new CuaDriverError(
        `failed to spawn cua-driver: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.child = child;

    this.rl = createInterface({ input: child.stdout as NodeJS.ReadableStream, crlfDelay: Infinity });
    this.rl.on('line', (line: string) => this.handleLine(line));

    child.on('error', (err) => {
      this.ready = false;
      this.failAll(new CuaDriverError(`cua-driver process error: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      this.ready = false;
      this.failAll(
        new CuaDriverError(`cua-driver exited (code=${code}, signal=${signal ?? 'none'})`),
      );
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.onLog(`[cua-driver] ${text}`);
    });

    try {
      let initialized = false;
      let lastError: unknown = null;
      for (const protocolVersion of MCP_PROTOCOL_VERSIONS) {
        try {
          const result = await this.request('initialize', {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: 'Spirit', version: '1' },
          });
          void result;
          this.negotiatedProtocolVersion = protocolVersion;
          initialized = true;
          break;
        } catch (err) {
          if (!isProtocolVersionMismatch(err)) throw err;
          lastError = err;
          this.onLog(`[cua-driver] protocol ${protocolVersion} rejected, trying older`);
        }
      }
      if (!initialized) {
        throw lastError instanceof Error
          ? lastError
          : new CuaDriverError('cua-driver rejected all MCP protocol versions');
      }
      this.notify('notifications/initialized');
      this.ready = true;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    if (!this.ready) throw new CuaDriverError('cua-driver is not connected');
    const result = await this.request('tools/call', { name, arguments: args });
    return (result ?? {}) as ToolResult;
  }

  // Advertised tools (Phase 6). Populated by fetchTools(); `toolSet` lets the
  // engine route an action to native when the driver doesn't expose the tool,
  // instead of degrading the whole session.
  private tools: string[] | null = null;

  get toolNames(): string[] {
    return this.tools ?? [];
  }

  get hasToolSet() {
    return {
      has: (name: string): boolean => (this.tools ? this.tools.includes(name) : true),
    };
  }

  // Ask the driver what tools it exposes (tools/list) and cache the names.
  // Unknown-failure tolerant: a directory-less driver leaves the set unknown
  // (hasToolSet then assumes everything is available and lets a real call
  // fail → session degrade, the pre-Phase-6 behavior).
  async fetchTools(): Promise<void> {
    if (!this.ready) throw new CuaDriverError('cua-driver is not connected');
    try {
      const result = (await this.request('tools/list', {})) as { tools?: Array<{ name?: string }> } | null;
      const names = (result?.tools ?? [])
        .map((t) => t?.name)
        .filter((n): n is string => typeof n === 'string');
      if (names.length > 0) this.tools = names;
    } catch (err) {
      if (err instanceof CuaDriverError && /timed out/.test(err.message)) throw err;
      this.onLog(`[cua-driver] tools/list unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  close(): void {    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.failAll(new CuaDriverError('cua-driver client closed'));
    this.rl?.close();
    this.rl = null;
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  }

  private notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<unknown> {
    const child = this.child;
    if (!child || this.closed) {
      return Promise.reject(new CuaDriverError('cua-driver is not connected'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CuaDriverError(`timed out after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private write(message: JsonRpcMessage): void {
    const child = this.child;
    if (!child?.stdin || !child.stdin.writable) {
      throw new CuaDriverError('cua-driver stdin is not writable');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage | null = null;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.onLog(`[cua-driver] non-JSON stdout line ignored: ${line.slice(0, 120)}`);
      return;
    }
    if (!message) return;

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(
            new CuaDriverError(
              `cua-driver MCP error (code ${message.error.code ?? 'unknown'}): ${message.error.message ?? 'unknown'}`,
            ),
          );
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    if (message.method === 'notifications/message') {
      const text = message.params?.message;
      if (typeof text === 'string' && text) this.onLog(`[cua-driver] ${text}`);
    }
  }

  private failAll(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }
}

// Kill stray cua-driver daemons left by an unclean exit (force-quit, crash).
// A zombie keeps its AgentCursorOverlay window on screen — fullscreen,
// topmost, eating input — while Spirit looks dead. Scoped to our own vendored
// binary name only. Called once at startup, when no session can exist yet,
// so anything running under that name is stale by definition.
export function killStaleDriverProcesses(onLog: (msg: string) => void = () => {}): void {
  const run = (cmd: string, args: string[]): void => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout) => {
      if (err) return;
      if (stdout && /cua-driver/i.test(stdout)) {
        onLog('[cua-driver] stale daemon sweep done');
      }
    });
  };
  if (process.platform === 'win32') {
    run('taskkill.exe', ['/F', '/IM', 'cua-driver.exe']);
  } else {
    run('pkill', ['-x', 'cua-driver']);
  }
}