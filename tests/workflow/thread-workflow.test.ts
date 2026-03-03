import { describe, expect, it } from "vitest";
import type { ThreadMessagePayload } from "@/chat/workflow/types";
import { runThreadMessageLoop } from "@/chat/workflow/thread-workflow";

function createPayload(overrides: Partial<ThreadMessagePayload> = {}): ThreadMessagePayload {
  const dedupKey = overrides.dedupKey ?? "slack:C123:1700000000.100:1700000000.200";
  const normalizedThreadId = overrides.normalizedThreadId ?? "slack:C123:1700000000.100";
  return {
    dedupKey,
    kind: overrides.kind ?? "new_mention",
    message:
      overrides.message ??
      ({
        id: dedupKey.split(":").at(-1) ?? "1700000000.200",
        author: {
          userId: "U_TEST"
        },
        attachments: []
      } as unknown as ThreadMessagePayload["message"]),
    normalizedThreadId,
    thread:
      overrides.thread ??
      ({
        channelId: "slack:C123"
      } as ThreadMessagePayload["thread"])
  };
}

async function* toAsyncIterable(items: ThreadMessagePayload[]): AsyncIterable<ThreadMessagePayload> {
  for (const item of items) {
    yield item;
  }
}

describe("runThreadMessageLoop", () => {
  it("deduplicates repeated payloads by dedupKey", async () => {
    const payloadA = createPayload({ dedupKey: "slack:C123:1700000000.100:1" });
    const payloadADuplicate = createPayload({ dedupKey: "slack:C123:1700000000.100:1" });
    const payloadB = createPayload({ dedupKey: "slack:C123:1700000000.100:2" });
    const processed: string[] = [];

    await runThreadMessageLoop(toAsyncIterable([payloadA, payloadADuplicate, payloadB]), {
      processMessage: async (payload) => {
        processed.push(payload.dedupKey);
      }
    });

    expect(processed).toEqual(["slack:C123:1700000000.100:1", "slack:C123:1700000000.100:2"]);
  });

  it("continues processing after a payload failure", async () => {
    const payloadA = createPayload({ dedupKey: "slack:C123:1700000000.100:1" });
    const payloadB = createPayload({ dedupKey: "slack:C123:1700000000.100:2" });
    const processed: string[] = [];
    const failures: Array<{ dedupKey: string; errorMessage: string }> = [];

    await runThreadMessageLoop(toAsyncIterable([payloadA, payloadB]), {
      processMessage: async (payload) => {
        processed.push(payload.dedupKey);
        if (payload.dedupKey.endsWith(":1")) {
          throw new Error("turn failed");
        }
      },
      onProcessingError: async ({ payload, errorMessage }) => {
        failures.push({
          dedupKey: payload.dedupKey,
          errorMessage
        });
      }
    });

    expect(processed).toEqual(["slack:C123:1700000000.100:1", "slack:C123:1700000000.100:2"]);
    expect(failures).toEqual([
      {
        dedupKey: "slack:C123:1700000000.100:1",
        errorMessage: "turn failed"
      }
    ]);
  });
});
