import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { signQueueMessage, verifyQueueMessage } from "@/chat/queue/sign";
import { useConfig } from "../../fixtures/config";

const schema = z.object({ id: z.string().min(1) }).strict();
const config = {
  context: "test.queue.v1",
  maxAgeMs: 100,
  schema,
  signatureVersion: "v1" as const,
  parts: (message: { id: string }) => [message.id],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("queue sign", () => {
  it("signs valid messages and rejects changed, expired, or malformed messages", () => {
    useConfig({ secrets: { juniorSecret: "test-secret" } });
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
    useConfig({ secrets: { juniorSecret: "test-secret" } });
    const signed = signQueueMessage(config, { id: "job-1" }, 1_000);

    expect(verifyQueueMessage(config, signed, Number.NaN)).toEqual({
      status: "unavailable",
      reason: "invalid_clock",
    });
    vi.stubEnv("JUNIOR_SECRET", undefined);
    useConfig();
    expect(verifyQueueMessage(config, signed, 1_050)).toEqual({
      status: "unavailable",
      reason: "missing_secret",
    });
  });
});
