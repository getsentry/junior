import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createQueueMessageCodec } from "@/chat/queue-jobs/message";

const originalJuniorSecret = process.env.JUNIOR_SECRET;
const messageSchema = z.object({ id: z.string().min(1) }).strict();
const codec = createQueueMessageCodec({
  context: "test.queue.v1",
  maxAgeMs: 100,
  schema: messageSchema,
  signatureVersion: "v1",
  signingParts: (message) => [message.id],
});

afterEach(() => {
  if (originalJuniorSecret === undefined) {
    delete process.env.JUNIOR_SECRET;
  } else {
    process.env.JUNIOR_SECRET = originalJuniorSecret;
  }
});

describe("queue message codec", () => {
  it("signs valid messages and rejects changed, expired, or malformed messages", () => {
    process.env.JUNIOR_SECRET = "test-secret";
    const signed = codec.sign({ id: "job-1" }, 1_000);

    expect(codec.verify(signed, 1_050)).toEqual({
      status: "verified",
      message: { id: "job-1" },
    });
    expect(codec.verify({ ...signed, id: "job-2" }, 1_050)).toEqual({
      status: "rejected",
      reason: "signature_mismatch",
    });
    expect(codec.verify(signed, 1_101)).toEqual({
      status: "rejected",
      reason: "expired",
    });
    expect(codec.verify({ ...signed, unexpected: true }, 1_050)).toEqual({
      status: "rejected",
      reason: "malformed",
    });
  });

  it("reports unavailable verification dependencies", () => {
    process.env.JUNIOR_SECRET = "test-secret";
    const signed = codec.sign({ id: "job-1" }, 1_000);

    expect(codec.verify(signed, Number.NaN)).toEqual({
      status: "unavailable",
      reason: "invalid_clock",
    });
    delete process.env.JUNIOR_SECRET;
    expect(codec.verify(signed, 1_050)).toEqual({
      status: "unavailable",
      reason: "missing_secret",
    });
  });
});
