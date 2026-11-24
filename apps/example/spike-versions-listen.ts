/**
 * Spike for getsentry/junior#3776. Do not merge.
 *
 * Proves that one function holds a Postgres `LISTEN` session on the direct
 * Neon endpoint for a full streamed response and gets `NOTIFY` from another
 * connection. It reads and writes no tables.
 *
 * Runs only when `VERCEL_ENV` is `preview`. Vercel deployment protection
 * gates every Preview URL, so only Vercel team members reach it. Production
 * serves a custom domain that protection skips, so it gets a 404.
 */
import { randomUUID } from "node:crypto";
import { Client, neon } from "@neondatabase/serverless";
import type { FetchApp } from "./live-preview.ts";

const BASE_PATH = "/__spike/versions-listen";
const CHANNEL = "junior_spike_versions_listen";
const APPLICATION_NAME = "junior-spike-listen";
const KEEPALIVE_MS = 15_000;
const KEEPALIVE_TIMEOUT_MS = 5_000;
// Ends under the 300 s function limit, so the stream never ends as a 504.
const MAX_STREAM_MS = 285_000;
// Bounds direct sessions on the shared database.
const MAX_LISTENERS = 4;

const instanceId = randomUUID().slice(0, 8);
const instanceStartedAt = new Date().toISOString();
let openListeners = 0;

// Same rule as `readMigrationDatabaseUrl`: drop `-pooler` from a Neon host.
function directDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const [endpoint, ...domain] = url.hostname.split(".");
  if (endpoint?.endsWith("-pooler") && url.hostname.endsWith(".neon.tech")) {
    url.hostname = [endpoint.slice(0, -"-pooler".length), ...domain].join(".");
  }
  return url.toString();
}

function databaseUrl(): string {
  const value = process.env["DATABASE_URL"]?.trim();
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}

type ServerStats = {
  backends: number;
  spikeListeners: number;
  maxConnections: number;
  postmasterStartedAt: string;
};

// Reads only Postgres system views.
async function readServerStats(): Promise<ServerStats> {
  const sql = neon(databaseUrl());
  const rows = await sql.query(
    `SELECT
       (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS backends,
       (SELECT count(*)::int FROM pg_stat_activity WHERE application_name = $1) AS spike_listeners,
       current_setting('max_connections')::int AS max_connections,
       pg_postmaster_start_time()::text AS postmaster_started_at`,
    [APPLICATION_NAME],
  );
  const row = rows[0] as Record<string, unknown>;
  return {
    backends: Number(row["backends"]),
    spikeListeners: Number(row["spike_listeners"]),
    maxConnections: Number(row["max_connections"]),
    postmasterStartedAt: String(row["postmaster_started_at"]),
  };
}

function sseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify({ t: Date.now(), instanceId, ...(data as object) })}\n\n`,
  );
}

function listenStream(request: Request): Response {
  if (openListeners >= MAX_LISTENERS) {
    return Response.json({ error: "too many listeners" }, { status: 429 });
  }
  openListeners++;
  const url = new URL(request.url);
  const keepaliveMs =
    url.searchParams.get("keepalive") === "0" ? 0 : KEEPALIVE_MS;
  const openedAt = Date.now();
  const client = new Client({
    connectionString: directDatabaseUrl(databaseUrl()),
    application_name: APPLICATION_NAME,
  });
  let closed = false;
  let notifications = 0;
  let keepalives = 0;
  let timers: ReturnType<typeof setInterval>[] = [];
  let closeStream: ((reason: string) => Promise<void>) | undefined;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sseEvent(event, data));
        } catch {
          void close("enqueue_failed");
        }
      };
      const close = async (reason: string) => {
        if (closed) return;
        send("end", {
          reason,
          heldMs: Date.now() - openedAt,
          notifications,
          keepalives,
        });
        closed = true;
        for (const timer of timers) clearInterval(timer);
        timers = [];
        openListeners--;
        request.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // Already closed or cancelled.
        }
        await client.end().catch(() => undefined);
      };
      closeStream = close;
      const onAbort = () => void close("client_aborted");
      request.signal.addEventListener("abort", onAbort, { once: true });

      client.on("notification", (message) => {
        notifications++;
        send("notify", { payload: message.payload });
      });
      client.on("error", (error) => {
        send("listener_error", { message: error.message });
        void close("listener_error");
      });
      client.on("end", () => void close("listener_end"));

      try {
        const connectStartedAt = Date.now();
        await client.connect();
        await client.query(`LISTEN ${CHANNEL}`);
        const pid = await client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        send("ready", {
          pid: pid.rows[0]?.pid,
          connectMs: Date.now() - connectStartedAt,
          instanceStartedAt,
          stats: await readServerStats(),
        });
      } catch (error) {
        send("listener_error", {
          message: error instanceof Error ? error.message : String(error),
        });
        await close("connect_failed");
        return;
      }

      // Without it, a silently dropped socket looks healthy and misses every
      // notification.
      if (keepaliveMs > 0) {
        timers.push(
          setInterval(() => {
            const startedAt = Date.now();
            let timeout: ReturnType<typeof setTimeout> | undefined;
            void Promise.race([
              client.query("SELECT 1"),
              new Promise((_, reject) => {
                timeout = setTimeout(
                  () => reject(new Error("keepalive timed out")),
                  KEEPALIVE_TIMEOUT_MS,
                );
              }),
            ])
              .then(() => {
                keepalives++;
                send("keepalive", { rttMs: Date.now() - startedAt });
              })
              .catch((error: unknown) => {
                send("listener_error", {
                  message:
                    error instanceof Error ? error.message : String(error),
                });
                void close("keepalive_failed");
              })
              .finally(() => clearTimeout(timeout));
          }, keepaliveMs),
        );
      }
      timers.push(
        setInterval(() => {
          if (Date.now() - openedAt >= MAX_STREAM_MS)
            void close("max_duration");
        }, 1_000),
      );
    },
    async cancel() {
      await closeStream?.("client_cancelled");
    },
  });

  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream",
      connection: "keep-alive",
    },
  });
}

async function sendNotify(request: Request): Promise<Response> {
  const label = new URL(request.url).searchParams.get("label") ?? "";
  const sql = neon(databaseUrl());
  const sentAt = Date.now();
  // Pooled URL, like the app writes that would fire the triggers.
  await sql.query("SELECT pg_notify($1, $2)", [
    CHANNEL,
    JSON.stringify({ label: label.slice(0, 64), sentAt, from: instanceId }),
  ]);
  return Response.json({
    sentAt,
    notifyMs: Date.now() - sentAt,
    instanceId,
    stats: await readServerStats(),
  });
}

/** Serve the spike routes on Previews only, in front of `app`. */
export function withVersionsListenSpike<Rest extends unknown[]>(
  app: FetchApp<Rest>,
): FetchApp<Rest> {
  return {
    fetch(request, ...rest) {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith(BASE_PATH)) return app.fetch(request, ...rest);
      if (process.env["VERCEL_ENV"] !== "preview") {
        return new Response("Not found", { status: 404 });
      }
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (pathname === `${BASE_PATH}/stream`) return listenStream(request);
      if (pathname === `${BASE_PATH}/notify`) return sendNotify(request);
      if (pathname === `${BASE_PATH}/stats`) {
        return readServerStats().then((stats) =>
          Response.json({ instanceId, instanceStartedAt, stats }),
        );
      }
      return new Response("Not found", { status: 404 });
    },
  };
}
