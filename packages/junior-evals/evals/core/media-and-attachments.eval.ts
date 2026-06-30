import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals } from "../../src/helpers";

describeEval("Media and Attachments", slackEvals, (it) => {
  it("when the user asks for an image, attach an image instead of replying with text alone", async ({
    run,
  }) => {
    await run({
      overrides: { mock_image_generation: true },
      events: [mention("show me how you feel")],
      criteria: rubric({
        pass: ["The assistant responds by attaching an image in the thread."],
        fail: [
          "Do not respond with text that merely describes an image.",
          "Do not claim an image was attached when the reply is text-only.",
          "Do not include sandbox setup failure text.",
        ],
      }),
    });
  });
});
