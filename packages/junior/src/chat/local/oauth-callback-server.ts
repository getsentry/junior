import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { GET as handlePluginOAuthCallback } from "@/handlers/oauth-callback";
import { GET as handleMcpOAuthCallback } from "@/handlers/mcp-oauth-callback";
import type { WaitUntilFn } from "@/handlers/types";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { syncLocalOAuthCredential } from "@/chat/local/credential-sync";

const LOCAL_OAUTH_TIMEOUT_MS = 10 * 60 * 1000;
const LOCAL_OAUTH_CALLBACK_TIMEOUT_MS = 60 * 1000;

/**
 * Own one loopback callback listener and at most one active authorization.
 *
 * Call `beginAuthorization` before waiting. Success, cancellation, timeout,
 * and `close` all settle that wait exactly once.
 */
interface LocalOAuthCallbackServer {
  beginAuthorization: (authorizationUrl: string) => void;
  cancelAuthorization: () => void;
  close: () => Promise<void>;
  port: number;
  waitForAuthorization: () => Promise<void>;
}

interface PendingAuthorization {
  callbackStarted: boolean;
  finish: (result: Error | true) => void;
  result: Promise<Error | true>;
  settled: boolean;
  state: string;
  timeout: NodeJS.Timeout;
}

function decodeProvider(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const provider = decodeURIComponent(value);
    return /^[a-z][a-z0-9-]*$/.test(provider) ? provider : undefined;
  } catch {
    return undefined;
  }
}

/** Start the loopback callback that completes OAuth in the local CLI process. */
export async function startLocalOAuthCallbackServer(
  agentRunner: AgentRunner,
): Promise<LocalOAuthCallbackServer> {
  let pendingAuthorization: PendingAuthorization | undefined;

  const completeAuthorization = (
    authorization: PendingAuthorization,
    result: Error | true,
  ): void => {
    if (authorization.settled) {
      return;
    }
    authorization.settled = true;
    clearTimeout(authorization.timeout);
    authorization.finish(result);
  };
  const cancelAuthorization = (): void => {
    const authorization = pendingAuthorization;
    if (!authorization) {
      return;
    }
    pendingAuthorization = undefined;
    completeAuthorization(
      authorization,
      new Error("Local OAuth authorization canceled"),
    );
  };

  const server = createServer(async (incoming, outgoing) => {
    const host = incoming.headers.host ?? "127.0.0.1";
    let requestUrl: URL;
    try {
      requestUrl = new URL(incoming.url ?? "/", `http://${host}`);
    } catch {
      outgoing.writeHead(400).end("Invalid callback request");
      return;
    }
    const mcpMatch = requestUrl.pathname.match(
      /^\/api\/oauth\/callback\/mcp\/([^/]+)$/,
    );
    const pluginMatch = requestUrl.pathname.match(
      /^\/api\/oauth\/callback\/([^/]+)$/,
    );
    const provider = decodeProvider(mcpMatch?.[1] ?? pluginMatch?.[1]);
    if (!provider) {
      outgoing.writeHead(404).end("Not found");
      return;
    }
    const authorization = pendingAuthorization;
    if (
      !authorization ||
      authorization.callbackStarted ||
      authorization.settled ||
      requestUrl.searchParams.get("state") !== authorization.state
    ) {
      outgoing.writeHead(409).end("No matching authorization request");
      return;
    }
    authorization.callbackStarted = true;
    clearTimeout(authorization.timeout);
    authorization.timeout = setTimeout(() => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(504).end("Authorization callback timed out");
      }
      completeAuthorization(
        authorization,
        new Error("Timed out completing OAuth authorization"),
      );
    }, LOCAL_OAUTH_CALLBACK_TIMEOUT_MS);

    const backgroundTasks: Promise<unknown>[] = [];
    const waitUntil: WaitUntilFn = (task) => {
      backgroundTasks.push(
        typeof task === "function" ? Promise.resolve().then(task) : task,
      );
    };

    try {
      const request = new Request(requestUrl, { method: "GET" });
      const response = mcpMatch
        ? await handleMcpOAuthCallback(request, provider, waitUntil, {
            agentRunner,
          })
        : await handlePluginOAuthCallback(request, provider, waitUntil, {
            agentRunner,
          });
      const body = Buffer.from(await response.arrayBuffer());
      await Promise.all(backgroundTasks);
      if (response.ok) {
        if (!mcpMatch) {
          const tokens = await createUserTokenStore().get(
            "local-cli",
            provider,
          );
          if (!tokens) {
            throw new Error(
              `${provider} authorization completed without a stored credential`,
            );
          }
          await syncLocalOAuthCredential(provider, tokens);
        }
      }
      if (authorization.settled) {
        return;
      }
      if (response.ok) {
        completeAuthorization(authorization, true);
      } else {
        completeAuthorization(
          authorization,
          new Error(
            `${provider} authorization callback failed with HTTP ${response.status}`,
          ),
        );
      }
      outgoing.writeHead(
        response.status,
        Object.fromEntries(response.headers.entries()),
      );
      outgoing.end(body);
    } catch (error) {
      if (!outgoing.headersSent) {
        outgoing.writeHead(500).end("Authorization callback failed");
      }
      completeAuthorization(
        authorization,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    beginAuthorization: (authorizationUrl) => {
      if (pendingAuthorization) {
        throw new Error("Local OAuth already has an active authorization");
      }
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (!state) {
        throw new Error("Local OAuth authorization URL is missing state");
      }
      let finish: (result: Error | true) => void = () => undefined;
      const result = new Promise<Error | true>((resolve) => {
        finish = resolve;
      });
      const authorization: PendingAuthorization = {
        callbackStarted: false,
        finish,
        result,
        settled: false,
        state,
        timeout: setTimeout(() => {
          completeAuthorization(
            authorization,
            new Error("Timed out waiting for OAuth authorization"),
          );
        }, LOCAL_OAUTH_TIMEOUT_MS),
      };
      pendingAuthorization = authorization;
    },
    cancelAuthorization,
    port: address.port,
    waitForAuthorization: async () => {
      const authorization = pendingAuthorization;
      if (!authorization) {
        throw new Error("Local OAuth has no active authorization");
      }
      const result = await authorization.result;
      if (pendingAuthorization === authorization) {
        pendingAuthorization = undefined;
      }
      if (result instanceof Error) {
        throw result;
      }
    },
    close: async () => {
      cancelAuthorization();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
