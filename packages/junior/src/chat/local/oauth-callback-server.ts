import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { GET as handlePluginOAuthCallback } from "@/handlers/oauth-callback";
import { GET as handleMcpOAuthCallback } from "@/handlers/mcp-oauth-callback";
import type { WaitUntilFn } from "@/handlers/types";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { syncLocalOAuthCredential } from "@/chat/local/credential-sync";

const LOCAL_OAUTH_TIMEOUT_MS = 10 * 60 * 1000;

export interface LocalOAuthCallbackServer {
  close: () => Promise<void>;
  port: number;
  waitForAuthorization: () => Promise<void>;
}

/** Start the loopback callback that completes OAuth in the local CLI process. */
export async function startLocalOAuthCallbackServer(
  agentRunner: AgentRunner,
): Promise<LocalOAuthCallbackServer> {
  let settleAuthorization:
    | { reject: (error: Error) => void; resolve: () => void }
    | undefined;
  let pendingResult: Error | true | undefined;

  const completeAuthorization = (result: Error | true): void => {
    if (!settleAuthorization) {
      pendingResult = result;
      return;
    }
    if (result === true) {
      settleAuthorization.resolve();
    } else {
      settleAuthorization.reject(result);
    }
  };

  const server = createServer(async (incoming, outgoing) => {
    const host = incoming.headers.host ?? "127.0.0.1";
    const requestUrl = new URL(incoming.url ?? "/", `http://${host}`);
    const mcpMatch = requestUrl.pathname.match(
      /^\/api\/oauth\/callback\/mcp\/([^/]+)$/,
    );
    const pluginMatch = requestUrl.pathname.match(
      /^\/api\/oauth\/callback\/([^/]+)$/,
    );
    const provider = decodeURIComponent(
      mcpMatch?.[1] ?? pluginMatch?.[1] ?? "",
    );
    if (!provider) {
      outgoing.writeHead(404).end("Not found");
      return;
    }

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
          await syncLocalOAuthCredential(provider, "local-cli", tokens);
        }
        completeAuthorization(true);
      } else {
        completeAuthorization(
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
    port: address.port,
    waitForAuthorization: async () => {
      if (pendingResult) {
        const result = pendingResult;
        pendingResult = undefined;
        if (result instanceof Error) {
          throw result;
        }
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          settleAuthorization = undefined;
          reject(new Error("Timed out waiting for OAuth authorization"));
        }, LOCAL_OAUTH_TIMEOUT_MS);
        settleAuthorization = {
          reject: (error) => {
            clearTimeout(timeout);
            settleAuthorization = undefined;
            reject(error);
          },
          resolve: () => {
            clearTimeout(timeout);
            settleAuthorization = undefined;
            resolve();
          },
        };
      });
    },
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
