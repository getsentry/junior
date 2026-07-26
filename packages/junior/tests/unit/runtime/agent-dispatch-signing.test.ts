import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyDispatchCallbackRequest } from "@/chat/agent-dispatch/signing";
import { createSignedDispatchCallbackRequest } from "../../fixtures/agent-dispatch";

describe("agent dispatch callback signing", () => {
  beforeEach(() => {
    process.env.JUNIOR_SECRET = "dispatch-secret";
  });

  afterEach(() => {
    delete process.env.JUNIOR_SECRET;
  });

  it("verifies callbacks emitted by older deployments", async () => {
    await expect(
      verifyDispatchCallbackRequest(
        createSignedDispatchCallbackRequest({
          id: "dispatch_123",
          expectedVersion: 3,
        }),
      ),
    ).resolves.toEqual({
      id: "dispatch_123",
      expectedVersion: 3,
    });
  });

  it("rejects callbacks whose signature does not match the body", async () => {
    await expect(
      verifyDispatchCallbackRequest(
        createSignedDispatchCallbackRequest(
          {
            id: "dispatch_123",
            expectedVersion: 3,
          },
          { signature: "v1=deadbeef" },
        ),
      ),
    ).resolves.toBeUndefined();
  });
});
