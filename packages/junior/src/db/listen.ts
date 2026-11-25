import { Client as NeonClient } from "@neondatabase/serverless";
import pg from "pg";
import type { SqlDriver } from "@/chat/config";
import { readDirectDatabaseUrl } from "./direct-url";

/**
 * The session runs `SELECT 1` this often. A socket that drops with no close
 * frame reports nothing, and a `NOTIFY` sent to a dead session is lost, so
 * the ping is the only way to notice.
 */
const PING_INTERVAL_MS = 15_000;
const PING_TIMEOUT_MS = 5_000;

/** The part of `pg` and Neon's `Client` that a `LISTEN` session uses. */
interface ListenClient {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: "end" | "notification", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  query(text: string): Promise<unknown>;
}

/** A Postgres session that holds `LISTEN` on one channel. */
export interface ListenSession {
  /** End the session. `onLost` does not run after this. */
  close(): Promise<void>;
}

/**
 * Open a session on the direct endpoint of `databaseUrl` and `LISTEN` on
 * `channel`. The pooled endpoint cannot hold a `LISTEN`, because it shares
 * one server session between clients.
 *
 * `onNotify` runs for each notification. `onLost` runs at most once, when
 * the session fails, ends, or misses a ping. The caller then opens a new
 * session: a `NOTIFY` sent while no session listens is lost.
 */
export async function openListenSession(args: {
  applicationName: string;
  channel: string;
  databaseUrl: string;
  driver: SqlDriver;
  onLost(error: Error): void;
  onNotify(): void;
}): Promise<ListenSession> {
  const config = { connectionString: readDirectDatabaseUrl(args.databaseUrl) };
  const client: ListenClient =
    args.driver === "postgres" ? new pg.Client(config) : new NeonClient(config);
  let connected = false;
  let ended = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  const end = async () => {
    ended = true;
    clearInterval(ping);
    await client.end().catch(() => undefined);
  };
  const lose = (error: Error) => {
    if (ended) return;
    void end();
    // Before `LISTEN` succeeds, the failure rejects the open instead.
    if (connected) args.onLost(error);
  };
  // pg emits `error` on an idle client and throws when nothing listens.
  client.on("error", lose);
  try {
    await client.connect();
    // A connection string's `application_name` wins over the config, so set
    // it on the session.
    await client.query(`SET application_name = '${args.applicationName}'`);
    await client.query(`LISTEN "${args.channel}"`);
    connected = true;
  } catch (error) {
    await end();
    throw error;
  }
  client.on("notification", () => {
    if (!ended) args.onNotify();
  });
  client.on("end", () => lose(new Error("LISTEN session ended")));
  ping = setInterval(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("LISTEN session missed a ping")),
        PING_TIMEOUT_MS,
      );
    });
    void Promise.race([client.query("SELECT 1"), timeout])
      .catch((error: unknown) =>
        lose(error instanceof Error ? error : new Error(String(error))),
      )
      .finally(() => clearTimeout(timer));
  }, PING_INTERVAL_MS);
  ping.unref?.();
  return { close: end };
}
