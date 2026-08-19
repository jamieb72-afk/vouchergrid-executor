import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ExecutionEngine } from "@executor-js/execution";

import {
  makeInMemoryMcpSessionStore,
  McpEngineBuildError,
  type McpBuildServerOptions,
} from "./in-memory-session-store";
import { defaultMcpResource, type Principal } from "./seams";
import { createExecutorMcpServer } from "./tool-server";

const TEST_PRINCIPAL: Principal = {
  accountId: "acct_test",
  organizationId: "org_test",
  organizationName: "Test Org",
  email: "test@example.com",
  name: "Test",
  avatarUrl: null,
  roles: ["user"],
};

const engine: ExecutionEngine = {
  execute: (code) => Effect.succeed({ result: `ran: ${code}` }),
  executeWithPause: (code) =>
    Effect.succeed({ status: "completed", result: { result: `ran: ${code}` } }),
  resume: () => Effect.succeed(null),
  isExecutionSettled: () => Effect.succeed(false),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("in-memory MCP lifecycle test executor"),
};

it("preserves native elicitation mode when creating an in-memory MCP session", async () => {
  let buildOptions: McpBuildServerOptions | undefined;
  const sessions = makeInMemoryMcpSessionStore((_principal, options) => {
    buildOptions = options;
    return Effect.fail(new McpEngineBuildError({ cause: "stop after capturing options" }));
  });

  const result = await Effect.runPromise(
    sessions.store.dispatch({
      request: new Request("https://executor.test/mcp?elicitation_mode=native", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: { elicitation: { form: {} } },
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
        }),
      }),
      principal: TEST_PRINCIPAL,
      resource: defaultMcpResource,
      sessionId: null,
      method: "POST",
    }),
  );

  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(500);
  expect(buildOptions?.elicitationMode).toEqual({ mode: "native" });
});

it("evicts a session that remains idle past the TTL", async () => {
  const sessions = makeInMemoryMcpSessionStore(
    (_principal, options) =>
      createExecutorMcpServer({ engine, ...options }).pipe(
        Effect.map((mcpServer) => ({ mcpServer, engine })),
      ),
    { sessionIdleTtlMs: 300 },
  );
  const response = (await Effect.runPromise(
    sessions.store.dispatch({
      request: new Request("https://executor.test/mcp", {
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
            clientInfo: { name: "idle-test", version: "1.0.0" },
          },
        }),
      }),
      principal: TEST_PRINCIPAL,
      resource: defaultMcpResource,
      sessionId: null,
      method: "POST",
    }),
  )) as Response;
  const sessionId = response.headers.get("mcp-session-id") ?? "";

  expect(response.status).toBe(200);
  expect(sessionId).not.toBe("");
  expect(sessions.sessionCount()).toBe(1);
  expect(await sessions.sweepIdleSessions(Date.now() + 1_000)).toBe(1);
  expect(sessions.sessionCount()).toBe(0);

  const afterEviction = await Effect.runPromise(
    sessions.store.dispatch({
      request: new Request("https://executor.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-session-id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
      principal: TEST_PRINCIPAL,
      resource: defaultMcpResource,
      sessionId,
      method: "POST",
    }),
  );
  expect(afterEviction).toBe("not-found");
  await sessions.close();
});
