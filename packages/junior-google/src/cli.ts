/**
 * Admin CLI for the Google account that Junior acts as.
 *
 * `connect` is the out-of-band alternative to the web setup page. It opens no
 * Slack surface and never prints tokens. The browser returns the
 * authorization code to a one-time loopback listener on this machine.
 */
import { createServer } from "node:http";
import { userInfo } from "node:os";
import { InvalidArgumentError, type Command } from "commander";
import type {
  PluginCliActionContext,
  PluginCliCommandDefinition,
} from "@sentry/junior-plugin-api";
import { readGoogleConfig, type GoogleConfig } from "./config";
import {
  connectGoogleAccount,
  createGoogleSignInRequest,
  GoogleConnectError,
  googleAuthorizationUrl,
} from "./oauth";
import { getGoogleAccount, googleAccountStatus, type GoogleDb } from "./store";

const DEFAULT_LOOPBACK_PORT = 8765;
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new InvalidArgumentError("--port must be between 1024 and 65535");
  }
  return port;
}

async function requireConfig(
  ctx: PluginCliActionContext,
): Promise<GoogleConfig | undefined> {
  const config = readGoogleConfig();
  if (!config) {
    await ctx.io.writeError(
      "Google plugin is not configured. Set GOOGLE_WORKSPACE_CLIENT_ID, GOOGLE_WORKSPACE_CLIENT_SECRET, and GOOGLE_WORKSPACE_ACCOUNT_EMAIL.\n",
    );
  }
  return config;
}

/** Wait for Google to redirect the browser back to the loopback listener. */
async function waitForLoopbackCode(input: {
  /** Runs once the listener is ready, so the sign-in URL is never shown early. */
  onListening(): Promise<void> | void;
  port: number;
  state: string;
  timeoutMs?: number;
}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/oauth/callback") {
        response.writeHead(404).end();
        return;
      }
      const finish = (message: string, result: () => void) => {
        response
          .writeHead(200, {
            Connection: "close",
            "Content-Type": "text/plain; charset=utf-8",
            "Referrer-Policy": "no-referrer",
          })
          .end(`${message}\nYou can close this window.\n`);
        clearTimeout(timer);
        server.close();
        result();
      };
      if (url.searchParams.get("state") !== input.state) {
        finish("Sign-in state did not match.", () =>
          reject(new GoogleConnectError("Sign-in state did not match.")),
        );
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code) {
        const message = `Google sign-in did not finish (${error ?? "no code"}).`;
        finish(message, () => reject(new GoogleConnectError(message)));
        return;
      }
      finish("Google sign-in received. Return to your terminal.", () =>
        resolve(code),
      );
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new GoogleConnectError("Timed out waiting for Google sign-in."));
    }, input.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(input.port, "127.0.0.1", () => {
      Promise.resolve(input.onListening()).catch((error: unknown) => {
        clearTimeout(timer);
        server.close();
        reject(error);
      });
    });
  });
}

async function runConnect(
  ctx: PluginCliActionContext,
  options: { port: number },
): Promise<number> {
  const config = await requireConfig(ctx);
  if (!config) return 1;

  const redirectUri = `http://127.0.0.1:${options.port}/oauth/callback`;
  const signIn = createGoogleSignInRequest();

  try {
    const code = await waitForLoopbackCode({
      onListening: () =>
        ctx.io.writeOutput(
          [
            `Open this URL in a browser and sign in as ${config.accountEmail}:`,
            "",
            googleAuthorizationUrl({ config, redirectUri, request: signIn }),
            "",
            `Waiting for Google to redirect to ${redirectUri} ...`,
            "",
          ].join("\n"),
        ),
      port: options.port,
      state: signIn.state,
    });
    const connected = await connectGoogleAccount({
      code,
      codeVerifier: signIn.codeVerifier,
      config,
      connectedBy: `cli:${userInfo().username}`,
      db: ctx.db as GoogleDb,
      redirectUri,
    });
    await ctx.io.writeOutput(
      `Connected ${connected.accountEmail} (scopes: ${connected.scope}).\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof GoogleConnectError) {
      await ctx.io.writeError(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function runStatus(ctx: PluginCliActionContext): Promise<number> {
  const config = await requireConfig(ctx);
  if (!config) return 1;
  const record = await getGoogleAccount(
    ctx.db as GoogleDb,
    config.accountEmail,
  );
  if (!record) {
    await ctx.io.writeOutput(
      `account=${config.accountEmail}\nstatus=not_connected\n`,
    );
    return 0;
  }
  const status = googleAccountStatus(record);
  await ctx.io.writeOutput(
    [
      `account=${status.accountEmail}`,
      "status=connected",
      `connected_at=${status.connectedAt}`,
      `connected_by=${status.connectedBy}`,
      `scope=${status.scope}`,
      "",
    ].join("\n"),
  );
  return 0;
}

/** Create the plugin-owned `google` admin CLI command. */
export function createGoogleCliCommand(): PluginCliCommandDefinition {
  return {
    name: "google",
    summary: "Connect and inspect Junior's Google account",
    configure(command: Command, junior) {
      command
        .command("connect")
        .description(
          "Sign in as Junior's Google account in a browser and store the grant",
        )
        .option(
          "--port <port>",
          "Loopback port registered as an OAuth redirect URI",
          parsePort,
          DEFAULT_LOOPBACK_PORT,
        )
        .action(
          junior.action(async (ctx, options) => {
            return await runConnect(ctx, options as { port: number });
          }),
        );
      command
        .command("status")
        .description("Show whether Junior's Google account is connected")
        .action(junior.action(async (ctx) => await runStatus(ctx)));
    },
  };
}
