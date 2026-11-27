/**
 * Core's Turn queue for the agent test fixture on the core Turn engine. A
 * local Vercel Queues server, as `junior chat --engine core` runs, pushes each
 * Turn message to the app's core routes. Each push is tracked, so a call ends
 * after its Turns; a push that waits for a retry delay is not tracked yet.
 */
import { getChatConfig } from "@/chat/config";
import {
  startLocalVercelQueueServer,
  type LocalVercelQueueServer,
} from "@/chat/queue/local-server";
import { TURN_ENDED_TOPIC, TURN_STEP_TOPIC } from "@/core/turn/topic";
import {
  JUNIOR_TURN_ENDED_CALLBACK_ROUTE,
  JUNIOR_TURN_STEP_CALLBACK_ROUTE,
} from "@/deployment";

// The server pushes to the app in process, so the host is never resolved.
const APP_URL = "http://fixture.localhost";

/**
 * Start the Turn queue when the installed config runs Turns on core.
 * Returns undefined on main, which has no Turn queue.
 */
export async function startCoreTurnQueue(args: {
  /** Sends a push to the current app. */
  fetch: (request: Request) => Promise<Response>;
  /** Counts a push as work that a call waits for. */
  track: (task: Promise<unknown>) => void;
}): Promise<LocalVercelQueueServer | undefined> {
  const config = getChatConfig();
  if (config.turnEngine !== "core") {
    return undefined;
  }
  // The queue client keeps the URL of its first send, so every app of the
  // process uses one server port.
  const port = config.queue.apiUrl
    ? Number(new URL(config.queue.apiUrl).port)
    : 0;
  if (!port) {
    throw new Error(
      "JUNIOR_TURN_ENGINE=core runs a local queue server. Set JUNIOR_QUEUE_API_URL to a free local URL with a port, such as http://127.0.0.1:4100.",
    );
  }
  return await startLocalVercelQueueServer({
    consumers: [
      {
        consumerGroup: "local",
        topic: TURN_STEP_TOPIC,
        url: new URL(JUNIOR_TURN_STEP_CALLBACK_ROUTE, APP_URL).href,
      },
      {
        consumerGroup: "local",
        topic: TURN_ENDED_TOPIC,
        url: new URL(JUNIOR_TURN_ENDED_CALLBACK_ROUTE, APP_URL).href,
      },
    ],
    fetch: (request) => {
      const response = args.fetch(request);
      args.track(response);
      return response;
    },
    port,
  });
}
