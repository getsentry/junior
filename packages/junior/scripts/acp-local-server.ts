/**
 * Serve one loopback ACP process and run the official client through the
 * local dashboard authorization route. This is test equipment.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "@/app";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { getSqlExecutor } from "@/chat/db";
import {
  closeConversationFixture,
  createConversationWebHarness,
} from "../tests/fixtures/conversation";
import { streamScript } from "../tests/fixtures/conversation-work";

const DEFAULT_PORT = 3099;
const DEFAULT_REPLY = "Local Junior ACP completed this Turn.";
const JUNIOR_PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

function localPort(): number {
  const raw = process.env.JUNIOR_ACP_LOCAL_PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("JUNIOR_ACP_LOCAL_PORT must be an integer from 0 to 65535");
  }
  return port;
}

await migrateSchema(getSqlExecutor());
const harness = await createConversationWebHarness(
  streamScript(process.env.JUNIOR_ACP_LOCAL_REPLY?.trim() || DEFAULT_REPLY),
);
// Use the loopback request origin, not deployed callback origins from env files.
delete process.env.JUNIOR_BASE_URL;
delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
delete process.env.VERCEL_URL;
const app = await createApp({
  conversationWork: harness.conversationWork,
  dashboard: { authRequired: false },
});
let drainActive = false;

/** Drain queued Conversation work while the smoke client waits. */
async function drainQueuedWork(): Promise<void> {
  if (drainActive || !harness.queue.hasQueuedMessages()) return;
  drainActive = true;
  try {
    await harness.drain();
  } catch (error) {
    console.error("Local ACP queue drain failed", error);
    exitAfterShutdown(1);
  } finally {
    drainActive = false;
  }
}

const drainTimer = setInterval(() => void drainQueuedWork(), 10);
const server = serve({
  fetch: app.fetch,
  hostname: "127.0.0.1",
  port: localPort(),
});
if (!server.listening) {
  await once(server, "listening");
}

const address = server.address() as AddressInfo;
const url = `http://127.0.0.1:${address.port}/api/acp`;
console.log(`Local ACP URL: ${url}`);

let smoke: ReturnType<typeof spawn> | undefined;
let shutdownPromise: Promise<void> | undefined;

/** Stop the HTTP client and server, then close test adapters. */
function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    clearInterval(drainTimer);
    if (smoke?.exitCode === null && smoke.signalCode === null) {
      smoke.kill("SIGTERM");
    }
    server.close();
    await once(server, "close");
    await closeConversationFixture();
  })();
  return shutdownPromise;
}

/** Finish cleanup and exit from a terminal runtime edge. */
function exitAfterShutdown(code: number): void {
  void shutdown().then(
    () => process.exit(code),
    (error) => {
      console.error("Local ACP shutdown failed", error);
      process.exit(1);
    },
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    exitAfterShutdown(signal === "SIGINT" ? 130 : 143);
  });
}

console.log("Running the official SDK smoke client...");
let smokeExitCode = 1;
try {
  smoke = spawn(process.execPath, ["--import", "tsx", "scripts/acp-smoke.ts"], {
    cwd: JUNIOR_PACKAGE_ROOT,
    env: {
      ...process.env,
      JUNIOR_ACP_FOLLOW_UP:
        process.env.JUNIOR_ACP_FOLLOW_UP?.trim() || "Send a follow-up.",
      JUNIOR_ACP_AUTO_AUTHORIZE: "true",
      JUNIOR_ACP_URL: url,
    },
    stdio: "inherit",
  });
  const [code, signal] = await once(smoke, "exit");
  if (signal) {
    throw new Error(`Local ACP smoke client stopped with ${signal}`);
  }
  smokeExitCode = code ?? 1;
} finally {
  await shutdown();
}
if (smokeExitCode !== 0) process.exitCode = smokeExitCode;
