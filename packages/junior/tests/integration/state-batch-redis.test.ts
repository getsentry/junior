import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai/compat";
import { loadSnapshot, saveSnapshot } from "@/chat/cache-warming/snapshot";
import {
  disconnectStateAdapter,
  getStateAdapter,
  getStateValues,
  setStateValues,
} from "@/chat/state/adapter";

// Chat config reads the state adapter when it loads, so set it first. CI
// runs Redis at REDIS_URL. Locally, compose.yaml runs it on port 6382.
const previousEnv = vi.hoisted(() => {
  const previous = {
    JUNIOR_STATE_ADAPTER: process.env["JUNIOR_STATE_ADAPTER"],
    REDIS_URL: process.env["REDIS_URL"],
    JUNIOR_STATE_KEY_PREFIX: process.env["JUNIOR_STATE_KEY_PREFIX"],
  };
  process.env["JUNIOR_STATE_ADAPTER"] = "redis";
  process.env["REDIS_URL"] =
    process.env["REDIS_URL"]?.trim() || "redis://localhost:6382";
  process.env["JUNIOR_STATE_KEY_PREFIX"] = `junior_test_${crypto.randomUUID()}`;
  return previous;
});

// Later files in the same worker must not run on this file's Redis state.
afterAll(async () => {
  try {
    await disconnectStateAdapter();
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

describe("batched Redis state values", () => {
  it("uses the same keys and values as single reads and writes", async () => {
    const state = getStateAdapter();
    const written = `written-${randomUUID()}`;
    const batched = `batched-${randomUUID()}`;
    await state.set(written, { seq: 1 }, 60_000);

    await expect(
      getStateValues(state, [written, `missing-${randomUUID()}`]),
    ).resolves.toEqual([{ seq: 1 }, null]);

    await setStateValues(state, [{ key: batched, value: { seq: 2 } }], 60_000);
    await expect(state.get(batched)).resolves.toEqual({ seq: 2 });
  });

  it("stores the images of a cache warming snapshot in one batch", async () => {
    const state = getStateAdapter();
    const conversationId = `conversation-${randomUUID()}`;
    const image = {
      type: "image" as const,
      data: "aW1n",
      mimeType: "image/png",
    };
    const context: Context = {
      messages: [
        {
          role: "user",
          content: [image, { type: "text", text: "Look." }, image],
          timestamp: 1,
        },
        {
          role: "user",
          content: [{ ...image, data: "b3RoZXI=" }],
          timestamp: 2,
        },
      ],
    };

    await expect(
      saveSnapshot(
        state,
        conversationId,
        `snapshot:${conversationId}`,
        context,
        60_000,
      ),
    ).resolves.toMatchObject({ imageCount: 2 });
    await expect(
      loadSnapshot(state, conversationId, `snapshot:${conversationId}`),
    ).resolves.toEqual(context);
  });
});
