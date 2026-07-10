import { assistantMessages, describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import { mention, rubric, slackEvals } from "../../src/helpers";

describeEval("Media and Attachments", slackEvals, (it) => {
  it("when the user asks for an image, attach an image instead of replying with text alone", async ({
    run,
  }) => {
    const result = await run({
      overrides: { mock_image_generation: true },
      initialEvents: [
        mention("make an image showing how you feel and share it here"),
      ],
      criteria: rubric({
        pass: ["The assistant responds by attaching an image in the thread."],
        fail: [
          "Do not respond with text that merely describes an image.",
          "Do not claim an image was attached when the reply is text-only.",
          "Do not include sandbox setup failure text.",
        ],
      }),
    });

    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "imageGenerate" }),
        expect.objectContaining({ name: "sendMessage" }),
      ]),
    );
    expect(
      assistantMessages(result.session).some((message) => {
        const files = message.metadata?.files;
        return (
          Array.isArray(files) &&
          files.some(
            (file) =>
              file &&
              typeof file === "object" &&
              "isImage" in file &&
              file.isImage === true,
          )
        );
      }),
    ).toBe(true);
  });
});
