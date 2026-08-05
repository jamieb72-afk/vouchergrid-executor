// Selfhost-only: the shared refresh gate must hold under real session
// concurrency, and must RELEASE once a grant settles.
//
// The cross-session scenario next door races two sessions. This one races eight
// through a barrier upstream that holds every first call until all have arrived,
// so the contention is forced rather than left to the scheduler — without a
// shared gate the refresh-grant count scales 1:1 with the session count, which
// is precisely what makes a rotating-token provider revoke the connection.
//
// The second wave then proves the gate is CLEARED after a grant settles rather
// than latched. A latched gate would replay a retired token; a gate that never
// released would deadlock every later refresh. Both failure modes are invisible
// to a single-wave test.
import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

/** Concurrent MCP sessions racing one connection's rotating refresh token. */
const SESSIONS = 8;
/** Upstream hits per session per wave: the rejected call plus its retry. */
const HITS_PER_SESSION_PER_WAVE = 2;
/** A partial wave means a session never reached upstream — fail loudly, don't hang. */
const WAVE_BARRIER_TIMEOUT_MS = 20_000;

type UpstreamHandle = {
  readonly url: string;
  readonly bearers: () => readonly string[];
  readonly close: () => void;
};

/**
 * Upstream that rejects a whole wave at once.
 *
 * The barrier is the point: it holds every session's first call until all
 * `waveSize` have arrived, then 401s them together. That forces the sessions
 * into a real simultaneous refresh rather than hoping the scheduler interleaves
 * them. `POST /_rearm` opens the next wave, so a second round proves the
 * in-flight gate is released after a grant settles rather than latched.
 */
const serveUpstream = (waveSize: number) =>
  Effect.acquireRelease(
    Effect.callback<UpstreamHandle>((resume) => {
      const bearers: string[] = [];
      let held: ServerResponse[] = [];
      let rejecting = true;
      let barrier: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        if (barrier) {
          clearTimeout(barrier);
          barrier = null;
        }
        const batch = held;
        held = [];
        rejecting = false;
        for (const response of batch) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_token" }));
        }
      };

      const server = createServer((request, response) => {
        const url = request.url ?? "";
        if (request.method === "POST" && url.startsWith("/_rearm")) {
          rejecting = true;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ rearmed: true }));
          return;
        }
        if (request.method === "GET" && url.startsWith("/issues")) {
          bearers.push((request.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
          if (rejecting) {
            held.push(response);
            if (held.length === waveSize) flush();
            else if (!barrier) barrier = setTimeout(flush, WAVE_BARRIER_TIMEOUT_MS);
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ issues: [] }));
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
            bearers: () => [...bearers],
            close: () => {
              if (barrier) clearTimeout(barrier);
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(server.close),
  );

const spec = (
  baseUrl: string,
  oauth: { readonly authorizationEndpoint: string; readonly tokenEndpoint: string },
): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Issues API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/issues": {
        get: {
          operationId: "listIssues",
          security: [{ oauth: ["issues.read"] }],
          responses: { "200": { description: "issues" } },
        },
      },
    },
    components: {
      securitySchemes: {
        oauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              scopes: { "issues.read": "Read issues" },
            },
          },
        },
      },
    },
  });

const invokeByAddressCode = (address: string) => `
const segments = ${JSON.stringify(address)}.split(".").slice(1);
let node = tools;
for (const segment of segments) node = node[segment];
const result = await node({});
return JSON.stringify(result);
`;

const completeAuthorization = (authorizationUrl: string) =>
  Effect.promise(async () => {
    const authorize = await fetch(authorizationUrl, { redirect: "manual" });
    const loginUrl = authorize.headers.get("location");
    if (!loginUrl) throw new Error(`authorize did not redirect: ${authorize.status}`);
    const login = await fetch(loginUrl, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from("alice:password").toString("base64")}` },
      redirect: "manual",
    });
    const callbackUrl = login.headers.get("location");
    if (!callbackUrl) throw new Error(`login did not redirect: ${login.status}`);
    const code = new URL(callbackUrl).searchParams.get("code");
    if (!code) throw new Error("callback carried no authorization code");
    return code;
  });

const distinct = (values: readonly string[]) => [...new Set(values)];

scenario(
  `OAuth refresh · ${SESSIONS} concurrent MCP sessions survive two rotating-token waves`,
  { timeout: 300_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveUpstream(SESSIONS);
      const oauth = yield* serveOAuthTestServer({ scopes: ["issues.read"] });
      const slug = unique("refreshstress");
      const clientSlug = OAuthClientSlug.make(unique("refreshstressc"));

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: spec(upstream.url, oauth) },
              slug,
              baseUrl: upstream.url,
              authenticationTemplate: [
                {
                  slug: "oauth",
                  kind: "oauth2",
                  authorizationUrl: oauth.authorizationEndpoint,
                  tokenUrl: oauth.tokenEndpoint,
                  scopes: ["issues.read"],
                },
              ],
            },
          });
          yield* client.oauth.createClient({
            payload: {
              owner: "org",
              slug: clientSlug,
              grant: "authorization_code",
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              clientId: "test-client",
              clientSecret: "test-secret",
              originIntegration: IntegrationSlug.make(slug),
            },
          });
          const started = yield* client.oauth.start({
            payload: {
              client: clientSlug,
              clientOwner: "org",
              owner: "org",
              name: ConnectionName.make("main"),
              integration: IntegrationSlug.make(slug),
              template: AuthTemplateSlug.make("oauth"),
            },
          });
          expect(started.status, "oauth.start redirects to the authorization server").toBe(
            "redirect",
          );
          if (started.status !== "redirect") return yield* Effect.die("no redirect");
          const code = yield* completeAuthorization(started.authorizationUrl);
          yield* client.oauth.complete({ payload: { state: started.state, code } });

          const address = (yield* client.tools.list({ query: {} }))
            .filter((tool) => String(tool.integration) === slug)
            .map((tool) => String(tool.address))
            .find((tool) => tool.endsWith("listIssues"));
          expect(address, "the OAuth-protected tool is in the catalog").toBeDefined();
          if (!address) return yield* Effect.die("no listIssues tool");
          yield* oauth.clearRequests;

          const sessions = Array.from({ length: SESSIONS }, () => mcp.session(identity));
          const call = (session: (typeof sessions)[number]) =>
            Effect.gen(function* () {
              let result = yield* session.call("execute", { code: invokeByAddressCode(address) });
              let approvals = 0;
              while (result.text.includes("executionId:") && approvals < 10) {
                result = yield* session.approvePaused(result.text);
                approvals += 1;
              }
              // Without a shared gate the loser redeems a retired refresh token
              // and the authorization server answers invalid_grant, so this is
              // the assertion that carries the user-visible failure.
              expect(result.ok, `MCP execute completed: ${result.text.slice(0, 400)}`).toBe(true);
            });

          const wave = () => Effect.all(sessions.map(call), { concurrency: "unbounded" });

          yield* wave();
          yield* Effect.promise(() =>
            fetch(`${upstream.url}/_rearm`, { method: "POST" }).then((response) => response.text()),
          );
          yield* wave();

          const refreshGrants = (yield* oauth.requests).filter(
            (request) =>
              request.path === "/token" && request.body.includes("grant_type=refresh_token"),
          );
          expect(
            refreshGrants,
            `${SESSIONS} sessions per wave joined one grant per wave`,
          ).toHaveLength(2);

          const bearers = upstream.bearers();
          expect(bearers, "every session called and retried in both waves").toHaveLength(
            SESSIONS * HITS_PER_SESSION_PER_WAVE * 2,
          );
          const firstAttempts = bearers.slice(0, SESSIONS);
          const firstRetries = bearers.slice(SESSIONS, SESSIONS * 2);
          const secondRetries = bearers.slice(SESSIONS * 3);
          expect(distinct(firstAttempts), "wave one started on one shared token").toHaveLength(1);
          expect(distinct(firstRetries), "wave one retried on one shared token").toHaveLength(1);
          expect(distinct(secondRetries), "wave two retried on one shared token").toHaveLength(1);
          expect(firstRetries[0], "wave one minted a new token").not.toBe(firstAttempts[0]);
          expect(secondRetries[0], "wave two minted another new token").not.toBe(firstRetries[0]);
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({
              params: {
                owner: "org",
                integration: IntegrationSlug.make(slug),
                name: ConnectionName.make("main"),
              },
            })
            .pipe(Effect.ignore);
          yield* client.oauth
            .removeClient({ params: { slug: clientSlug }, payload: { owner: "org" } })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
