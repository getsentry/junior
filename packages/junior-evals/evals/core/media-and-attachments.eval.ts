import { describe } from "vitest";
import { mention, rubric, slackEval } from "../helpers";

describe("Media and Attachments", () => {
  slackEval(
    "when the user asks for an image, attach an image instead of replying with text alone",
    {
      overrides: { mock_image_generation: true },
      events: [mention("show me how you feel")],
      criteria: rubric({
        contract:
          "An image-generation prompt returns an actual image attachment in the thread.",
        pass: ["The assistant responds by attaching an image in the thread."],
        fail: [
          "Do not respond with text that merely describes an image.",
          "Do not claim an image was attached when the reply is text-only.",
          "Do not include sandbox setup failure text.",
        ],
      }),
    },
  );
});
