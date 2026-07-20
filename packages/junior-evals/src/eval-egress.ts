import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Resolver, resolve4 } from "node:dns/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxEgressHttpInterceptor } from "@/chat/sandbox/egress/proxy";

const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const QUICK_TUNNEL_START_TIMEOUT_MS = 30_000;
const QUICK_TUNNEL_CONNECTED_PATTERN = /Registered tunnel connection/i;
const PUBLIC_HEALTH_TIMEOUT_MS = 20_000;
const QUICK_TUNNEL_ATTEMPTS = 3;
const RESET_PATH = "/__junior_eval/reset";
const STATE_PATH = "/__junior_eval/state";

interface EvalEgressOptions {
  interceptHttp?: SandboxEgressHttpInterceptor;
  readFixtureState?: () => Promise<unknown> | unknown;
  resetFixtures?: () => Promise<void> | void;
  verifyPublicUrl?: (baseUrl: string) => Promise<void>;
}

/** Running suite-level eval egress resources. */
export interface EvalEgress {
  baseUrl: string;
  close(): Promise<void>;
  controlToken: string;
  controlUrl: string;
  stateUrl: string;
}

/** Extract the public Quick Tunnel URL from cloudflared output. */
export function extractQuickTunnelUrl(output: string): string | undefined {
  return output.match(QUICK_TUNNEL_URL_PATTERN)?.[0];
}

function requestHeadersFromNode(
  headers: Record<string, string | string[] | undefined>,
): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else {
      result.set(key, value);
    }
  }
  return result;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Eval egress server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Resolve a Quick Tunnel hostname through public DNS when system DNS is stale. */
export async function resolveQuickTunnelIpv4(
  hostname: string,
): Promise<string> {
  let addresses: string[];
  try {
    addresses = await resolve4(hostname);
  } catch (systemError) {
    const publicResolver = new Resolver();
    publicResolver.setServers(["1.1.1.1", "8.8.8.8"]);
    try {
      addresses = await publicResolver.resolve4(hostname);
    } catch (publicError) {
      throw new AggregateError(
        [systemError, publicError],
        `Could not resolve ${hostname} through system or public DNS`,
        { cause: systemError },
      );
    }
  }
  const [address] = addresses;
  if (!address) {
    throw new Error(`No IPv4 address resolved for ${hostname}`);
  }
  return address;
}

async function writeResponse(
  target: ServerResponse,
  response: Response,
): Promise<void> {
  target.statusCode = response.status;
  target.statusMessage = response.statusText;
  response.headers.forEach((value, key) => {
    target.setHeader(key, value);
  });

  if (!response.body) {
    target.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      target.write(next.value);
    }
    target.end();
  } finally {
    reader.releaseLock();
  }
}

/** Serve health checks and credentialed sandbox requests for the eval worker. */
function createEvalEgressServer(options: EvalEgressOptions): {
  controlToken: string;
  server: Server;
} {
  const controlToken = randomUUID();
  let proxyRequest:
    | Promise<typeof import("@/handlers/sandbox-egress-proxy").ALL>
    | undefined;
  const loadProxyRequest = () =>
    (proxyRequest ??= import("@/handlers/sandbox-egress-proxy").then(
      (module) => module.ALL,
    ));

  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        if (incoming.url === "/health") {
          outgoing.setHeader("content-type", "application/json");
          outgoing.end(JSON.stringify({ ok: true }));
          return;
        }

        if (incoming.url === RESET_PATH && incoming.method === "POST") {
          if (incoming.headers.authorization !== `Bearer ${controlToken}`) {
            outgoing.statusCode = 401;
            outgoing.end("Unauthorized\n");
            return;
          }
          await options.resetFixtures?.();
          outgoing.statusCode = 204;
          outgoing.end();
          return;
        }

        if (incoming.url === STATE_PATH && incoming.method === "GET") {
          if (incoming.headers.authorization !== `Bearer ${controlToken}`) {
            outgoing.statusCode = 401;
            outgoing.end("Unauthorized\n");
            return;
          }
          outgoing.setHeader("content-type", "application/json");
          outgoing.end(
            JSON.stringify((await options.readFixtureState?.()) ?? {}),
          );
          return;
        }

        const request = new Request(
          new URL(incoming.url ?? "/", `http://${incoming.headers.host}`).href,
          {
            method: incoming.method,
            headers: requestHeadersFromNode(incoming.headers),
            ...(incoming.method === "GET" || incoming.method === "HEAD"
              ? {}
              : {
                  body: incoming as unknown as BodyInit,
                  duplex: "half",
                }),
          } as RequestInit,
        );
        // Delay the product handler import until Postgres setup replaces DATABASE_URL.
        const handleProxyRequest = await loadProxyRequest();
        await writeResponse(
          outgoing,
          await handleProxyRequest(request, {
            ...(options.interceptHttp
              ? { interceptHttp: options.interceptHttp }
              : {}),
          }),
        );
      } catch (error) {
        console.error(
          "Eval egress server request failed",
          error instanceof Error ? error.message : String(error),
        );
        outgoing.statusCode = 500;
        outgoing.setHeader("content-type", "text/plain; charset=utf-8");
        outgoing.end("Eval egress server error\n");
      }
    })();
  });

  return {
    server,
    controlToken,
  };
}

/** Wait until cloudflared has both allocated and connected the Quick Tunnel. */
function waitForQuickTunnel(tunnel: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    let baseUrl: string | undefined;
    let connected = false;
    const timer = setTimeout(() => {
      fail(
        new Error(
          `cloudflared did not provide a Quick Tunnel URL within ${QUICK_TUNNEL_START_TIMEOUT_MS}ms${output ? `:\n${output}` : ""}`,
        ),
      );
    }, QUICK_TUNNEL_START_TIMEOUT_MS);

    const cleanupControlListeners = () => {
      clearTimeout(timer);
      tunnel.off("error", fail);
      tunnel.off("exit", handleExit);
    };
    const succeed = () => {
      if (!baseUrl || !connected) return;
      if (settled) return;
      settled = true;
      cleanupControlListeners();
      resolve(baseUrl);
    };
    function fail(error: Error) {
      if (settled) return;
      settled = true;
      cleanupControlListeners();
      tunnel.stdout?.off("data", handleOutput);
      tunnel.stderr?.off("data", handleOutput);
      reject(error);
    }
    function handleExit(code: number | null, signal: NodeJS.Signals | null) {
      fail(
        new Error(
          `cloudflared exited before providing a Quick Tunnel URL (code=${code ?? "none"}, signal=${signal ?? "none"})${output ? `:\n${output}` : ""}`,
        ),
      );
    }
    function handleOutput(chunk: Buffer | string) {
      output = `${output}${chunk.toString()}`.slice(-20_000);
      baseUrl ??= extractQuickTunnelUrl(output);
      connected ||= QUICK_TUNNEL_CONNECTED_PATTERN.test(output);
      succeed();
    }

    tunnel.once("error", fail);
    tunnel.once("exit", handleExit);
    tunnel.stdout?.on("data", handleOutput);
    tunnel.stderr?.on("data", handleOutput);
  });
}

/** Stop cloudflared before the worker releases its local proxy server. */
async function stopTunnel(tunnel: ChildProcess): Promise<void> {
  if (tunnel.exitCode !== null || tunnel.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let failureTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (forceTimer) clearTimeout(forceTimer);
      if (failureTimer) clearTimeout(failureTimer);
      tunnel.off("close", finish);
      resolve();
    };
    forceTimer = setTimeout(() => {
      if (!tunnel.kill("SIGKILL")) {
        reject(new Error("cloudflared did not accept SIGKILL"));
        return;
      }
      failureTimer = setTimeout(() => {
        reject(new Error("cloudflared did not close after SIGKILL"));
      }, 5_000);
    }, 5_000);
    tunnel.once("close", finish);
    tunnel.kill("SIGTERM");
  });
}

function requestPublicProxy(baseUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const url = new URL("/api/internal/sandbox-egress", baseUrl);
      const address = await resolveQuickTunnelIpv4(url.hostname);
      const request = httpsRequest(
        {
          headers: { host: url.hostname },
          hostname: address,
          method: "GET",
          path: url.pathname,
          port: 443,
          servername: url.hostname,
          timeout: 3_000,
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.once("error", reject);
      request.once("timeout", () => {
        request.destroy(new Error("Public health request timed out"));
      });
      request.end();
    })().catch(reject);
  });
}

/** Wait until the public Quick Tunnel route reaches the real proxy handler. */
async function waitForPublicProxy(baseUrl: string): Promise<void> {
  const deadline = Date.now() + PUBLIC_HEALTH_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const status = await requestPublicProxy(baseUrl);
      if (status === 401) return;
      lastError = new Error(`HTTP ${status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Eval egress proxy was not publicly reachable at ${baseUrl}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { cause: lastError },
  );
}

/** Start one public egress proxy for the complete eval worker lifecycle. */
export async function startEvalEgress(
  options: EvalEgressOptions = {},
): Promise<EvalEgress> {
  const { controlToken, server } = createEvalEgressServer(options);
  let configDir: string | undefined;
  let tunnel: ChildProcess | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (tunnel) await stopTunnel(tunnel);
    } finally {
      try {
        if (server.listening) await closeServer(server);
      } finally {
        if (configDir) await rm(configDir, { force: true, recursive: true });
      }
    }
  };

  try {
    const port = await listen(server);
    configDir = await mkdtemp(path.join(tmpdir(), "junior-eval-egress-"));
    const configPath = path.join(configDir, "config.yml");
    await writeFile(configPath, "{}\n", "utf8");
    let lastError: unknown;
    for (let attempt = 1; attempt <= QUICK_TUNNEL_ATTEMPTS; attempt += 1) {
      tunnel = spawn(
        "cloudflared",
        [
          "tunnel",
          "--config",
          configPath,
          "--no-autoupdate",
          "--loglevel",
          "info",
          "--protocol",
          "http2",
          "--transport-loglevel",
          "error",
          "--url",
          `http://127.0.0.1:${port}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      try {
        const baseUrl = await waitForQuickTunnel(tunnel);
        await (options.verifyPublicUrl ?? waitForPublicProxy)(baseUrl);
        return {
          baseUrl,
          close,
          controlToken,
          controlUrl: new URL(RESET_PATH, `http://127.0.0.1:${port}`).href,
          stateUrl: new URL(STATE_PATH, `http://127.0.0.1:${port}`).href,
        };
      } catch (error) {
        lastError = error;
        await stopTunnel(tunnel);
        tunnel = undefined;
      }
    }
    throw new Error(
      `Eval egress failed after ${QUICK_TUNNEL_ATTEMPTS} Quick Tunnel attempts`,
      { cause: lastError },
    );
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Eval egress startup and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}
