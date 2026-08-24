import { createHash } from "node:crypto";
import { createMemoryState } from "@chat-adapter/state-memory";
import { describe, expect, it, vi } from "vitest";
import {
  acceptAcpRequest,
  bindAcpConnectionUser,
  completeAcpRequest,
  deleteAcpConnection,
  type AcpRequestReceipt,
} from "@sentry/junior-acp/testing";
import type { StateAdapter } from "chat";
import { deferred } from "../../fixtures/conversation-work";
import { readProxyProperty } from "../../fixtures/proxy-property";

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

function replayReceipt(): AcpRequestReceipt {
  return {
    outputs: [{ kind: "replay" }],
    sessionId: SESSION_ID,
  };
}

function loadReceipt(): AcpRequestReceipt {
  return {
    outputs: [
      { kind: "replay" },
      {
        kind: "message",
        message: { jsonrpc: "2.0", id: "load", result: {} },
      },
    ],
    sessionId: SESSION_ID,
  };
}

describe("ACP transport", () => {
  it("does not let browser authorization restore a deleted connection", async () => {
    const state = createMemoryState();
    await state.connect();
    const credentialHash = "0".repeat(64);
    await state.set(CONNECTION_KEY, {
      credentialHash,
      nonce: "transport-test",
    });
    const writeStarted = deferred();
    const releaseWrite = deferred();
    let blockConnectionWrite = true;
    const delayedState = new Proxy(state, {
      get(target, property) {
        if (property === "set") {
          return async (key: string, value: unknown, ttlMs?: number) => {
            if (key === CONNECTION_KEY && blockConnectionWrite) {
              blockConnectionWrite = false;
              writeStarted.resolve();
              await releaseWrite.promise;
            }
            await target.set(key, value, ttlMs);
          };
        }
        const value = readProxyProperty(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StateAdapter;

    const binding = bindAcpConnectionUser({
      connectionId: CONNECTION_ID,
      credentialHash,
      state: delayedState,
      user: {
        email: "viewer@example.com",
        id: "test:viewer@example.com",
        identities: [],
      },
    });
    await writeStarted.promise;
    const deletion = deleteAcpConnection(delayedState, CONNECTION_ID);
    releaseWrite.resolve();

    await expect(binding).resolves.toBe("completed");
    await expect(deletion).resolves.toBeUndefined();
    await expect(state.get(CONNECTION_KEY)).resolves.toBeNull();
    await state.disconnect();
  });

  it("does not create output after its connection expires", async () => {
    const state = createMemoryState();
    await state.connect();
    const createReceipt = vi.fn(async () => replayReceipt());

    await expect(
      acceptAcpRequest({
        connectionId: CONNECTION_ID,
        createReceipt,
        requestKey: REQUEST_KEY,
        state,
      }),
    ).resolves.toBe("expired");
    expect(createReceipt).not.toHaveBeenCalled();
    await state.disconnect();
  });

  it("rejects overflow without trimming pending output", async () => {
    const state = createMemoryState();
    await state.connect();
    await state.set(CONNECTION_KEY, {
      credentialHash: "0".repeat(64),
      nonce: "transport-test",
    });
    for (let index = 0; index < MAX_STREAM_ITEMS - 1; index += 1) {
      await state.appendToList(STREAM_ITEMS_KEY, {
        id: `existing-${index}`,
        output: {
          kind: "message",
          message: { jsonrpc: "2.0", id: index, result: {} },
        },
      });
    }
    const beforeMultiOutput = [...(await state.getList(STREAM_ITEMS_KEY))];
    await expect(
      completeAcpRequest({
        connectionId: CONNECTION_ID,
        receipt: loadReceipt(),
        requestKey: `${REQUEST_KEY}-multi-output`,
        state,
      }),
    ).resolves.toBe("full");
    await expect(state.getList(STREAM_ITEMS_KEY)).resolves.toEqual(
      beforeMultiOutput,
    );
    await state.appendToList(STREAM_ITEMS_KEY, {
      id: `existing-${MAX_STREAM_ITEMS - 1}`,
      output: {
        kind: "message",
        message: { jsonrpc: "2.0", id: MAX_STREAM_ITEMS - 1, result: {} },
      },
    });
    const createReceipt = vi.fn(async () => replayReceipt());
    const accept = () =>
      acceptAcpRequest({
        connectionId: CONNECTION_ID,
        createReceipt,
        reserveRoute: {
          connectionId: CONNECTION_ID,
          sessionId: SESSION_ID,
        },
        requestKey: REQUEST_KEY,
        state,
      });

    await expect(accept()).resolves.toBe("full");
    expect(createReceipt).not.toHaveBeenCalled();
    await expect(
      completeAcpRequest({
        connectionId: CONNECTION_ID,
        receipt: replayReceipt(),
        requestKey: `${REQUEST_KEY}-completion`,
        state,
      }),
    ).resolves.toBe("full");
    const pending = await state.getList(STREAM_ITEMS_KEY);
    expect(pending).toHaveLength(MAX_STREAM_ITEMS);
    expect(pending[0]).toMatchObject({ id: "existing-0" });

    await state.set(STREAM_CURSOR_KEY, {
      itemId: `existing-${MAX_STREAM_ITEMS - 1}`,
    });
    await expect(accept()).resolves.toBe("accepted");
    const reset = await state.getList(STREAM_ITEMS_KEY);
    expect(reset).toEqual([
      expect.objectContaining({
        id: REPLAY_ITEM_ID,
        output: { kind: "replay" },
      }),
    ]);
    expect(createReceipt).toHaveBeenCalledTimes(1);
    await state.disconnect();
  });
});
