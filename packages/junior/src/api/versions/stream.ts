import type { User } from "@sentry/junior-plugin-api";
import { getChatConfig } from "@/chat/config";
import { logException } from "@/chat/logging";
import { VERSIONS_STREAM_KEEPALIVE_EVENT } from "../schema/versions";
import type { VersionChanges } from "./changes";
import { readVersions } from "./read";

/**
 * A stream ends by itself after about this long. Vercel does not tell the
 * function when the client goes away, and a write to a closed client does
 * not fail, so the cap is what ends a stream that nobody reads. The client
 * reconnects and reads a fresh baseline. The cap also bounds how long a
 * revoked session keeps getting tokens.
 */
const STREAM_MAX_MS = 120_000;

/** Ends spread out, so tabs that opened together do not reconnect together. */
const STREAM_MAX_JITTER_MS = 20_000;

/** The stream ends this long before the function's max duration. */
const FUNCTION_DEADLINE_MARGIN_MS = 15_000;

/** The client counts a stream as healthy while it hears from it this often. */
const KEEPALIVE_MS = 15_000;

/**
 * After a read, the next one waits at least this long, the same as the poll
 * of a present reader. A busy viewer then costs no more than the poll.
 */
const MIN_READ_GAP_MS = 5_000;

/** The client waits this long, plus jitter, before it reconnects. */
const RETRY_MS = 1_000;
const RETRY_JITTER_MS = 2_000;

function streamMaxMs(): number {
  const functionMaxMs =
    getChatConfig().functionMaxDurationSeconds * 1_000 -
    FUNCTION_DEADLINE_MARGIN_MS;
  return Math.min(
    STREAM_MAX_MS -
      STREAM_MAX_JITTER_MS / 2 +
      Math.random() * STREAM_MAX_JITTER_MS,
    functionMaxMs,
  );
}

/**
 * Open an SSE stream of one viewer's `Versions`. The first message is the
 * baseline. After that, a message comes only when a write may have moved a
 * token and a fresh read differs from the last message. Each message is a
 * fresh `readVersions`, with the same access as the poll.
 */
export async function openVersionsStream(args: {
  changes: VersionChanges;
  conversationIds: readonly string[];
  viewer: User;
}): Promise<Response> {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      close();
    },
  });

  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let cap: ReturnType<typeof setTimeout> | undefined;
  let nextRead: ReturnType<typeof setTimeout> | undefined;
  let reading = false;
  let dirty = false;
  let lastReadAtMs = 0;
  let lastMessage: string | undefined;

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    clearTimeout(cap);
    clearTimeout(nextRead);
    unsubscribe?.();
    try {
      controller.close();
    } catch {
      // The client already cancelled the stream.
    }
  }

  const write = (chunk: string) => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      close();
    }
  };

  const read = async () => {
    reading = true;
    dirty = false;
    lastReadAtMs = Date.now();
    try {
      const message = JSON.stringify(
        await readVersions(args.viewer, {
          conversationIds: args.conversationIds,
        }),
      );
      if (message !== lastMessage) {
        lastMessage = message;
        write(`data: ${message}\n\n`);
      }
    } catch (error) {
      // The response already started, so no error status can reach the
      // client. The stream ends, and the client reconnects or polls.
      logException(error, "versions_stream.read_failed");
      close();
      return;
    } finally {
      reading = false;
    }
    if (dirty) scheduleRead();
  };

  // A change during a read waits for it and then reads again.
  function scheduleRead() {
    if (closed || reading || nextRead) return;
    nextRead = setTimeout(
      () => {
        nextRead = undefined;
        void read();
      },
      Math.max(0, lastReadAtMs + MIN_READ_GAP_MS - Date.now()),
    );
  }

  try {
    unsubscribe = await args.changes.subscribe({
      onChange: () => {
        dirty = true;
        scheduleRead();
      },
      onLost: close,
    });
  } catch (error) {
    close();
    throw error;
  }

  write(`retry: ${Math.round(RETRY_MS + Math.random() * RETRY_JITTER_MS)}\n\n`);
  keepAlive = setInterval(
    () => write(`event: ${VERSIONS_STREAM_KEEPALIVE_EVENT}\ndata: 1\n\n`),
    KEEPALIVE_MS,
  );
  keepAlive.unref?.();
  cap = setTimeout(close, streamMaxMs());
  cap.unref?.();
  // The session listens before this read, so no change after it is missed.
  void read();

  return new Response(body, {
    headers: {
      "cache-control": "private, no-store, no-transform",
      "content-type": "text/event-stream",
    },
  });
}
