import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { CuaDriverError, CuaDriverMcpClient } from '../electron/input/cua-driver-client';

// Fake child that speaks line-delimited JSON on PassThrough streams — the
// client's views of spawn/stdio are all we need; no real daemon is launched.
class FakeChild extends EventEmitter {
  pid = 4242;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function writeLine(stream: NodeJS.WritableStream, message: unknown): void {
  (stream as PassThrough).write(`${JSON.stringify(message)}\n`);
}

function initializeReply(id: number): unknown {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'cua-driver', version: '0.22.2' },
    },
  };
}

describe('CuaDriverMcpClient', () => {
  it('spawns the driver with the mcp subcommand and telemetry disabled, then handshakes', async () => {
    const child = new FakeChild();
    const seen: unknown[][] = [];
    child.stdin.on('data', (chunk: Buffer) => seen.push(JSON.parse(chunk.toString())));

    const spawnFn = vi.fn(
      (_exe: string, args: string[], _opts: SpawnOptions): ChildProcess =>
        child as unknown as ChildProcess,
    );

    // Respond to initialize once it arrives.
    child.stdin.on('data', (chunk: Buffer) => {
      const msg = JSON.parse(chunk.toString());
      if (msg.method === 'initialize') writeLine(child.stdout, initializeReply(msg.id));
    });

    const client = new CuaDriverMcpClient({
      exePath: 'C:/vendor/cua-driver.exe',
      spawnFn: spawnFn as never,
    });

    await client.connect();

    expect(spawnFn).toHaveBeenCalledOnce();
    const [exe, args, opts] = spawnFn.mock.calls[0];
    expect(exe).toBe('C:/vendor/cua-driver.exe');
    expect(args).toEqual(['mcp']);
    expect((opts as SpawnOptions).env!).toMatchObject({
      CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
    });
    expect(client.isReady).toBe(true);
    expect(client.childPid).toBe(4242);

    const first = seen[0] as Record<string, unknown>;
    expect(first.method).toBe('initialize');
    expect((first.params as Record<string, unknown>).protocolVersion).toBe('2026-07-28');
    expect(client.protocolVersion).toBe('2026-07-28');
    const second = seen[1] as Record<string, unknown>;
    expect(second.method).toBe('notifications/initialized');

    client.close();
  });

  it('falls back to older MCP protocol versions when the driver rejects the newest', async () => {
    const child = new FakeChild();
    const seen: unknown[][] = [];
    child.stdin.on('data', (chunk: Buffer) => seen.push(JSON.parse(chunk.toString())));
    child.stdin.on('data', (chunk: Buffer) => {
      const msg = JSON.parse(chunk.toString());
      if (msg.method !== 'initialize') return;
      if (msg.params?.protocolVersion === '2026-07-28') {
        writeLine(child.stdout, {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32602, message: 'Unsupported protocol version' },
        });
        return;
      }
      writeLine(child.stdout, initializeReply(msg.id));
    });

    const client = new CuaDriverMcpClient({
      exePath: 'C:/vendor/cua-driver.exe',
      spawnFn: ((): ChildProcess => child as unknown as ChildProcess) as never,
    });

    await client.connect();

    expect(client.isReady).toBe(true);
    expect(client.protocolVersion).toBe('2025-06-18');
    const versions = seen
      .filter((m) => (m as Record<string, unknown>).method === 'initialize')
      .map((m) => ((m as Record<string, unknown>).params as Record<string, unknown>).protocolVersion);
    expect(versions).toEqual(['2026-07-28', '2025-06-18']);

    client.close();
  });

  it('callTool resolves the matching id and ignores unrelated notifications', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    let initialized = false;
    child.stdin.on('data', (chunk: Buffer) => {
      const msg = JSON.parse(chunk.toString());
      if (msg.method === 'initialize') {
        writeLine(child.stdout, initializeReply(msg.id));
        return;
      }
      if (msg.method === 'notifications/initialized') {
        initialized = true;
        return;
      }
      if (msg.method === 'tools/call') {
        // Server-side notification first, then the response for the request.
        writeLine(child.stdout, {
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: { level: 'info', message: 'click delivered' },
        });
        writeLine(child.stdout, {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'clicked' }], isError: false },
        });
        return;
      }
    });

    const client = new CuaDriverMcpClient({
      exePath: 'C:/vendor/cua-driver.exe',
      spawnFn: spawnFn as never,
    });
    await client.connect();
    expect(initialized).toBe(true);

    const result = await client.callTool('click', { session: 'spirit', x: 10, y: 20 });
    expect(result.isError).toBe(false);
    expect(result.content?.[0]?.text).toBe('clicked');

    client.close();
  });

  it('callTool rejects on a JSON-RPC error response', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    child.stdin.on('data', (chunk: Buffer) => {
      const msg = JSON.parse(chunk.toString());
      if (msg.method === 'initialize') {
        writeLine(child.stdout, initializeReply(msg.id));
        return;
      }
      if (msg.method === 'notifications/initialized') return;
      if (msg.method === 'tools/call') {
        writeLine(child.stdout, {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'Method not found' },
        });
      }
    });

    const client = new CuaDriverMcpClient({
      exePath: 'C:/vendor/cua-driver.exe',
      spawnFn: spawnFn as never,
    });
    await client.connect();

    await expect(client.callTool('nope', {})).rejects.toThrow(/Method not found/);

    client.close();
  });

  it('rejects in-flight requests when the driver process exits', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    child.stdin.on('data', (chunk: Buffer) => {
      const msg = JSON.parse(chunk.toString());
      if (msg.method === 'initialize') writeLine(child.stdout, initializeReply(msg.id));
    });

    const client = new CuaDriverMcpClient({
      exePath: 'C:/vendor/cua-driver.exe',
      spawnFn: spawnFn as never,
      requestTimeoutMs: 20000,
    });
    await client.connect();

    const inflight = client.callTool('click', {});
    child.emit('exit', 1, null);

    await expect(inflight).rejects.toThrow(/cua-driver exited/);
    expect(client.isReady).toBe(false);

    client.close();
  });

  it('close() kills the child and rejects new work; connect() on a closed client throws', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    child.stdin.on('data', (chunk: Buffer) => {
      const msg = JSON.parse(chunk.toString());
      if (msg.method === 'initialize') writeLine(child.stdout, initializeReply(msg.id));
    });

    const client = new CuaDriverMcpClient({
      exePath: 'C:/vendor/cua-driver.exe',
      spawnFn: spawnFn as never,
    });
    await client.connect();

    client.close();
    expect(child.killed).toBe(true);
    expect(client.isClosed).toBe(true);
    await expect(client.callTool('click', {})).rejects.toThrow(CuaDriverError);

    const again = new CuaDriverMcpClient({
      exePath: 'C:/vendor/cua-driver.exe',
      spawnFn: spawnFn as never,
    });
    again.close();
    await expect(again.connect()).rejects.toThrow(/closed/);
  });

  it('fetchTools() caches the advertised tool names for routing', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    child.stdin.on('data', (chunk: Buffer) => {
      const msg = JSON.parse(chunk.toString());
      if (msg.method === 'initialize') {
        writeLine(child.stdout, initializeReply(msg.id));
        return;
      }
      if (msg.method === 'notifications/initialized') return;
      if (msg.method === 'tools/list') {
        writeLine(child.stdout, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              { name: 'click', inputSchema: { type: 'object' } },
              { name: 'type_text', inputSchema: { type: 'object' } },
              { name: 'get_cursor_position', inputSchema: { type: 'object' } },
            ],
          },
        });
      }
    });

    const client = new CuaDriverMcpClient({
      exePath: 'C:/vendor/cua-driver.exe',
      spawnFn: spawnFn as never,
    });
    await client.connect();

    expect(client.hasToolSet.has('click')).toBe(true); // unknown → assume available
    await client.fetchTools();
    expect(client.toolNames).toEqual(['click', 'type_text', 'get_cursor_position']);
    expect(client.hasToolSet.has('click')).toBe(true);
    expect(client.hasToolSet.has('get_cursor_position')).toBe(true);
    expect(client.hasToolSet.has('scroll')).toBe(false);

    client.close();
  });

  it('fetchTools() tolerates a directory-less driver without losing the session', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    child.stdin.on('data', (chunk: Buffer) => {
      const msg = JSON.parse(chunk.toString());
      if (msg.method === 'initialize') {
        writeLine(child.stdout, initializeReply(msg.id));
        return;
      }
      if (msg.method === 'notifications/initialized') return;
      if (msg.method === 'tools/list') {
        writeLine(child.stdout, {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'Method not found' },
        });
      }
    });

    const client = new CuaDriverMcpClient({
      exePath: 'C:/vendor/cua-driver.exe',
      spawnFn: spawnFn as never,
    });
    await client.connect();

    await expect(client.fetchTools()).resolves.toBeUndefined();
    expect(client.toolNames).toEqual([]);
    expect(client.hasToolSet.has('click')).toBe(true); // unknown → optimistic
    expect(client.isReady).toBe(true);

    client.close();
  });
});