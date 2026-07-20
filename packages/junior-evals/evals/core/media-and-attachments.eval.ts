import { describeEval, toolCalls } from "vitest-evals";
import { beforeAll, expect } from "vitest";
import { hasImageAttachment, mention, slackEvals } from "../../src/helpers";
import { warmSandboxSnapshot } from "../../src/snapshot-warmup";

const SNAPSHOT_WARMUP_TIMEOUT_MS = 10 * 60 * 1000;

describeEval("Media and Attachments", slackEvals, (it) => {
  beforeAll(async () => {
    await warmSandboxSnapshot();
  }, SNAPSHOT_WARMUP_TIMEOUT_MS);

  it("when the user asks for an image, attach an image instead of replying with text alone", async ({
    run,
  }) => {
    const result = await run({
      overrides: { mock_image_generation: true },
      initialEvents: [
        mention("make an image showing how you feel and share it here"),
      ],
    });

    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "imageGenerate" }),
        expect.objectContaining({ name: "sendMessage" }),
      ]),
    );
    expect(hasImageAttachment(result.session)).toBe(true);
  });
});
