import { createHash } from "node:crypto";
import { createMemoryState } from "@chat-adapter/state-memory";
import { describe, expect, it, vi } from "vitest";
import {
  acceptAcpRequest,
  completeAcpRequest,
  type AcpRequestReceipt,
} from "@sentry/junior-acp/testing";

const CONNECTION_ID = "9dddb5f1-bd8f-42cc-a88e-c3cb909354dd";
const CONNECTION_KEY = `junior:acp:v1:connection:${CONNECTION_ID}`;
const SESSION_ID = "local:acp:11111111111111111111111111111111";
const REQUEST_KEY = "overflow-request";

function stableHex(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

const STREAM_KEY = `junior:acp:v1:connection:${CONNECTION_ID}:stream:session:${stableHex(SESSION_ID)}`;
const STREAM_ITEMS_KEY = `${STREAM_KEY}:items`;
const STREAM_CURSOR_KEY = `${STREAM_KEY}:cursor`;
const MAX_STREAM_ITEMS = 1_024;
const REPLAY_ITEM_ID = `acp-item:${stableHex(`${REQUEST_KEY}:0`)}`;
const REPLAY_COMPLETION_KEY = `${STREAM_KEY}:complete:${stableHex(REPLAY_ITEM_ID)}`;

function replayReceipt(): AcpRequestReceipt {
  return {
    outputs: [
      {
        kind: "replay",
        sessionId: SESSION_ID,
      },
    ],
  };
}

describe("ACP transport", () => {
  it("rejects overflow without trimming pending output", async () => {
    const state = createMemoryState();
    await state.connect();
    await state.set(CONNECTION_KEY, {
      credentialHash: "0".repeat(64),
      nonce: "transport-test",
    });
    for (let index = 0; index < MAX_STREAM_ITEMS; index += 1) {
      await state.appendToList(STREAM_ITEMS_KEY, {
        id: `existing-${index}`,
        output: {
          kind: "message",
          message: { jsonrpc: "2.0", id: index, result: {} },
        },
      });
    }
    const createReceipt = vi.fn(async () => replayReceipt());
    const accept = () =>
      acceptAcpRequest({
        connectionId: CONNECTION_ID,
        createReceipt,
        requestKey: REQUEST_KEY,
        state,
      });

    await expect(accept()).resolves.toBe("full");
    await expect(
      completeAcpRequest({
        connectionId: CONNECTION_ID,
        receipt: replayReceipt(),
        requestKey: REQUEST_KEY,
        state,
      }),
    ).resolves.toBe("full");
    const pending = await state.getList(STREAM_ITEMS_KEY);
    expect(pending).toHaveLength(MAX_STREAM_ITEMS);
    expect(pending[0]).toMatchObject({ id: "existing-0" });

    await state.set(STREAM_CURSOR_KEY, {
      itemId: `existing-${MAX_STREAM_ITEMS - 1}`,
    });
    await state.set(REPLAY_COMPLETION_KEY, true);
    await expect(accept()).resolves.toBe("accepted");
    const reset = await state.getList(STREAM_ITEMS_KEY);
    expect(reset).toEqual([
      expect.objectContaining({
        id: REPLAY_ITEM_ID,
        output: { kind: "replay" },
      }),
    ]);
    await expect(state.get(REPLAY_COMPLETION_KEY)).resolves.toBeNull();
    expect(createReceipt).toHaveBeenCalledTimes(1);
    await state.disconnect();
  });
});
