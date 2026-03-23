import { describe } from "vitest";
import { mention, slackEval } from "../helpers";

describe("Conversational Evals: Media and Attachments", () => {
  slackEval("media: feeling prompt returns generated image attachment", {
    overrides: { mock_image_generation: true },
    events: [mention("show me how you feel")],
    criteria:
      "The assistant responds by actually attaching an image in the thread, not merely describing one in text. A text-only answer, or text claiming an image was attached, is insufficient. The output must not include sandbox setup failure text.",
  });
});
