import { describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { JUNIOR_TURN_STEP_CALLBACK_ROUTE } from "@/deployment";
import { buildTurnPromptLayouts } from "@/turn-steps/prompt";
import { createSlackWebhookTestClient } from "../fixtures/slack/webhook-client";

// Injected fault: the Turn prompt layouts cannot be built.
vi.mock("@/turn-steps/prompt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/turn-steps/prompt")>()),
  buildTurnPromptLayouts: vi.fn(async () => {
    throw new Error("The Turn prompt layouts failed to build");
  }),
}));

describe("createApp core Turn steps", () => {
  it("starts and serves its routes without building the Turn step consumer", async () => {
    const app = await createApp({ plugins: defineJuniorPlugins([]) });
    const response = await app.fetch(
      createSlackWebhookTestClient({
        signingSecret: "test-signing-secret",
      }).event({ type: "url_verification", challenge: "route-ok" }),
    );

    await expect(response.json()).resolves.toEqual({ challenge: "route-ok" });
    expect(buildTurnPromptLayouts).not.toHaveBeenCalled();

    const step = await app.fetch(
      new Request(`https://example.test${JUNIOR_TURN_STEP_CALLBACK_ROUTE}`, {
        method: "POST",
        body: "{}",
      }),
    );

    expect(step.status).toBe(500);
    expect(buildTurnPromptLayouts).toHaveBeenCalledTimes(1);
  });
});
