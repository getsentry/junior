import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { signQueueMessage, verifyQueueMessage } from "@/chat/queue/sign";

const originalJuniorSecret = process.env.JUNIOR_SECRET;
const schema = z.object({ id: z.string().min(1) }).strict();
const config = {
  context: "test.queue.v1",
  maxAgeMs: 100,
  schema,
  signatureVersion: "v1" as const,
  parts: (message: { id: string }) => [message.id],
};

afterEach(() => {
  if (originalJuniorSecret === undefined) {
    delete process.env.JUNIOR_SECRET;
  } else {
    process.env.JUNIOR_SECRET = originalJuniorSecret;
  }
});

describe("queue sign", () => {
  it("signs valid messages and rejects changed, expired, or malformed messages", () => {
    process.env.JUNIOR_SECRET = "test-secret";
    const signed = signQueueMessage(config, { id: "job-1" }, 1_000);

    expect(verifyQueueMessage(config, signed, 1_050)).toEqual({
      status: "verified",
      message: { id: "job-1" },
    });
    expect(
      verifyQueueMessage(config, { ...signed, id: "job-2" }, 1_050),
    ).toEqual({
      status: "rejected",
      reason: "signature_mismatch",
    });
    expect(verifyQueueMessage(config, signed, 1_101)).toEqual({
      status: "rejected",
      reason: "expired",
    });
    expect(
      verifyQueueMessage(config, { ...signed, unexpected: true }, 1_050),
    ).toEqual({
      status: "rejected",
      reason: "malformed",
    });
  });

  it("reports unavailable verification dependencies", () => {
    process.env.JUNIOR_SECRET = "test-secret";
    const signed = signQueueMessage(config, { id: "job-1" }, 1_000);

    expect(verifyQueueMessage(config, signed, Number.NaN)).toEqual({
      status: "unavailable",
      reason: "invalid_clock",
    });
    delete process.env.JUNIOR_SECRET;
    expect(verifyQueueMessage(config, signed, 1_050)).toEqual({
      status: "unavailable",
      reason: "missing_secret",
    });
  });
});
