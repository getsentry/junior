import { describe, expect, it } from "vitest";
import { buildAuthPauseResponse } from "@/chat/services/auth-pause-response";

describe("buildAuthPauseResponse", () => {
  it("shows the escaped user request in the public notice", () => {
    expect(
      buildAuthPauseResponse(
        "U123",
        "GitHub",
        "  Update <roadmap> & notify the team  ",
      ),
    ).toBe(
      "<@U123> I need access to GitHub to continue.\n\n*Why:* Update &lt;roadmap&gt; &amp; notify the team\n\nUse the link in the message above in this thread.",
    );
  });

  it("falls back to the generic notice without request text", () => {
    expect(buildAuthPauseResponse("U123", "GitHub")).toBe(
      "<@U123> I'll need you to authorize GitHub. Use the link in the message above in this thread.",
    );
  });
});
