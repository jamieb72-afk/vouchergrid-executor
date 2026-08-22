import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ExecutionEngine } from "@executor-js/execution";

import { createMcpRequestHandler } from "./mcp";

const engine: ExecutionEngine = {
  execute: (code) => Effect.succeed({ result: `ran: ${code}` }),
  executeWithPause: (code) =>
    Effect.succeed({ status: "completed", result: { result: `ran: ${code}` } }),
  resume: () => Effect.succeed(null),
  isExecutionSettled: () => Effect.succeed(false),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("local MCP lifecycle test executor"),
};

const initialize = async (
  mcp: ReturnType<typeof createMcpRequestHandler>,
  path = "/mcp/toolkits/shared-toolkit",
): Promise<string> => {
  const response = await mcp.handleRequest(
    new Request(`http://local.test${path}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "local-lifecycle-test", version: "1.0.0" },
        },
      }),
    }),
  );
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id") ?? "";
  expect(sessionId).not.toBe("");
  await response.body?.cancel();
  return sessionId;
};

describe("local MCP lifecycle", () => {
  it("shares one toolkit resource config across client sessions", async () => {
    let createCalls = 0;
    let closeCalls = 0;
    const mcp = createMcpRequestHandler({
      defaultConfig: { engine },
      createConfigForResource: () => {
        createCalls += 1;
        return {
          config: { engine },
          close: async () => {
            closeCalls += 1;
          },
        };
      },
    });

    await initialize(mcp);
    await initialize(mcp);

    expect(createCalls).toBe(1);
    expect(closeCalls).toBe(0);
    await mcp.close();
    expect(closeCalls).toBe(1);
  });

  it("evicts abandoned sessions after the idle TTL", async () => {
    const mcp = createMcpRequestHandler({
      defaultConfig: { engine },
      sessionIdleTtlMs: 40,
    });
    const sessionId = await initialize(mcp, "/mcp");

    await new Promise((resolve) => setTimeout(resolve, 120));
    const response = await mcp.handleRequest(
      new Request("http://local.test/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(404);
    await mcp.close();
  });
});
