// Module overview: the pg-boss jobs that hold local queue messages in the
// app's Postgres. The local queue provider (`local.ts`) adds jobs, and the
// local queue delivery (`local-delivery.ts`) pushes them to the callback
// routes. Both use the request format in this module.
//
// `pg-boss` is an optional peer dependency. Only dev installs need it.
import type { PgBoss } from "pg-boss";
import { getChatConfig } from "@/chat/config";
import { importAtRuntime } from "@/chat/import-at-runtime";
import { logException } from "@/chat/logging";

/** Headers that carry delivery facts on a pushed local queue message. */
export const LOCAL_QUEUE_HEADERS = {
  createdAt: "x-junior-queue-created-at",
  deliveryCount: "x-junior-queue-delivery-count",
  messageId: "x-junior-queue-message-id",
} as const;

/** The data of one local queue job. */
export interface LocalJobData {
  payload: unknown;
  /** Drop the message if it is not delivered within this many seconds. */
  retentionSeconds?: number | undefined;
  /**
   * When `send` ran, in epoch milliseconds of the app's clock. The database
   * clock can differ, such as in a Docker VM.
   */
  sentAt: number;
}

const SCHEMA = "junior_local_queue";

const QUEUE_OPTIONS = {
  // A job id drops a second send only while pg-boss still stores the first
  // job. So this is the dedupe window for idempotency keys.
  deleteAfterSeconds: 60 * 60,
  notify: true,
  retryBackoff: true,
  retryDelay: 1,
  retryDelayMax: 30,
  // Durable state owns the real attempt limit for conversation work. This
  // cap only stops a message that always fails from looping for ever.
  retryLimit: 50,
};

function isPgBossModule(value: unknown): value is typeof import("pg-boss") {
  return (
    typeof value === "object" &&
    value !== null &&
    "PgBoss" in value &&
    typeof value.PgBoss === "function"
  );
}

/**
 * Start a pg-boss instance on the app database. `deliver` also runs the
 * maintenance that retries jobs whose delivery stopped.
 */
export async function startLocalJobs(args: {
  deliver: boolean;
}): Promise<PgBoss> {
  const pgBoss = await importAtRuntime("pg-boss").catch((error: unknown) => {
    throw new Error(
      "JUNIOR_QUEUE_PROVIDER=local needs the pg-boss package installed",
      { cause: error },
    );
  });
  if (!isPgBossModule(pgBoss)) {
    throw new Error("The installed pg-boss package has no PgBoss class");
  }
  const boss = new pgBoss.PgBoss({
    connectionString: getChatConfig().sql.databaseUrl,
    max: args.deliver ? 10 : 2,
    openTelemetry: { enabled: false },
    schedule: false,
    schema: SCHEMA,
    supervise: args.deliver,
    useListenNotify: args.deliver,
  });
  boss.on("error", (error) => {
    logException(error, "queue.local.exception");
  });
  await boss.start();
  return boss;
}

/** Create the pg-boss queue of a topic, if it does not exist yet. */
export async function createLocalQueue(
  boss: PgBoss,
  topic: string,
): Promise<void> {
  await boss.createQueue(topic, QUEUE_OPTIONS);
}
