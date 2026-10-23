import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import { createMcpMessageHandler, type McpToolHandler } from "./protocol";
import { RELAY_HELLO, startRelayHost, type RelayHost } from "./relay-host";

const RELAY_SCRIPT = join(import.meta.dir, "relay-script.ts");

const tools: McpToolHandler = {
  listTools: () => [{ name: "guide_read", description: "Read the draft.", inputSchema: { type: "object", properties: {} } }],
  callTool: async (name, args) => ({ text: `called ${name} with ${JSON.stringify(args)}`, isError: false }),
};

describe("builder MCP protocol", () => {
  const handle = createMcpMessageHandler(tools, "1.2.3");

  it("negotiates the protocol version the client asks for when it knows it", async () => {
    const known = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect((known?.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
    const unknown = await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } });
    expect((unknown?.result as { protocolVersion: string }).protocolVersion).toBe("2025-11-25");
    expect((unknown?.result as { serverInfo: { name: string } }).serverInfo.name).toBe("plannotator-guide-builder");
  });

  it("lists and calls tools, ignores notifications, refuses the rest", async () => {
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = await handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect((list?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(["guide_read"]);
    const call = await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "guide_read", arguments: { a: 1 } } });
    expect(call?.result).toEqual({ content: [{ type: "text", text: 'called guide_read with {"a":1}' }], isError: false });
    const unknownTool = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm_rf" } });
    expect(unknownTool?.error?.code).toBe(-32602);
    const other = await handle({ jsonrpc: "2.0", id: 6, method: "resources/list" });
    expect(other?.error?.code).toBe(-32601);
  });
});

describe("builder MCP relay", () => {
  let host: RelayHost | null = null;
  afterEach(async () => {
    await host?.close();
    host = null;
  });

  it("relays an MCP client through the stdio script to the session's handler", async () => {
    host = await startRelayHost({ serverVersion: "test" });
    const session = host.openSession(tools);
    const child = spawn(process.execPath, [RELAY_SCRIPT], { env: { ...process.env, ...session.env }, stdio: ["pipe", "pipe", "pipe"] });
    const lines: string[] = [];
    let buf = "";
    const gotLines = (n: number) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out; got ${lines.length} lines`)), 5000);
        const check = () => {
          if (lines.length >= n) {
            clearTimeout(t);
            resolve();
          }
        };
        child.stdout.on("data", () => check());
        check();
      });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      buf += c;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guide_read", arguments: {} } })}\n`);
    await gotLines(2);
    expect(JSON.parse(lines[0]).result.protocolVersion).toBe("2025-06-18");
    expect(JSON.parse(lines[1]).result.content[0].text).toBe("called guide_read with {}");
    expect(session.connectionCount()).toBe(1);
    child.stdin.end();
    await new Promise((r) => child.once("exit", r));
    session.dispose();
  });

  it("drops a connection with a wrong token", async () => {
    host = await startRelayHost({ serverVersion: "test" });
    host.openSession(tools);
    const socket = connect(host.socketPath);
    await new Promise((r) => socket.once("connect", r));
    socket.write(`${JSON.stringify({ hello: RELAY_HELLO, token: "0".repeat(64) })}\n`);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    let received = "";
    socket.on("data", (d) => (received += d.toString()));
    await new Promise((r) => socket.once("close", r));
    expect(received).toBe("");
  });

  it("refuses to start the relay script without its session", async () => {
    const env = { ...process.env };
    delete env.PLANNOTATOR_GUIDE_MCP_SOCKET;
    delete env.PLANNOTATOR_GUIDE_MCP_TOKEN;
    const child = spawn(process.execPath, [RELAY_SCRIPT], { env, stdio: ["pipe", "pipe", "pipe"] });
    const code = await new Promise<number | null>((r) => child.once("exit", r));
    expect(code).toBe(2);
  });
});
