import type { Destination } from "@sentry/junior-plugin-api";
import type { Delivery } from "@/delivery/deliver";

/** One try of a send, as the recording Delivery saw it. */
export type RecordedSend = { text: string; destination: Destination };

/**
 * A Delivery that records every try of a send. A queued failure makes the
 * next try throw it, after the try is recorded.
 */
export function createRecordingDelivery() {
  const sends: RecordedSend[] = [];
  const failures: Error[] = [];
  const delivery: Delivery = {
    send: async ({ text, destination }) => {
      sends.push({ text, destination });
      const failure = failures.shift();
      if (failure) {
        throw failure;
      }
      return { providerMessageId: `message-${sends.length}` };
    },
  };
  return {
    delivery,
    sends: () => [...sends],
    failNext: (error: Error) => {
      failures.push(error);
    },
  };
}
