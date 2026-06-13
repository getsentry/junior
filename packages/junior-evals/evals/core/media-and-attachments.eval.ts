import { describeEval } from "vitest-evals";
import type { Message } from "chat";
import { mention, rubric, slackEvals } from "../helpers";

describeEval("Media and Attachments", slackEvals, (it) => {
  it("when image analysis is unavailable, acknowledge the image without inventing contents", async ({
    run,
  }) => {
    await run({
      events: [
        mention("<@U_APP> what does this screenshot show?", {
          attachments: [
            {
              type: "image",
              mimeType: "image/png",
              name: "dashboard-screenshot.png",
              url: "https://files.slack.com/private/dashboard-screenshot.png",
              fetchData: async () => Buffer.from("not-real-image-bytes"),
            },
          ] as Message["attachments"],
        }),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        contract:
          "When Slack includes an image but this runtime cannot analyze images, the assistant is honest about the limitation.",
        pass: [
          "assistant_posts contains exactly one reply.",
          "The reply acknowledges that an image or screenshot was attached.",
          "The reply clearly says it cannot inspect or analyze the image contents in this runtime.",
        ],
        allow: [
          "The reply may ask the user to describe the screenshot or provide text from it.",
        ],
        fail: [
          "Do not claim no image or screenshot was attached.",
          "Do not invent visual details such as colors, charts, UI labels, or people in the image.",
          "Do not say the image was successfully analyzed.",
        ],
      }),
    });
  });

  it("when the user asks for an image, attach an image instead of replying with text alone", async ({
    run,
  }) => {
    await run({
      overrides: {
        replyGeneration: { mockImageGeneration: true },
      },
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
    });
  });
});
