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
      "<@U123> I need access to GitHub to continue.\n\n*Why:* Update &lt;roadmap&gt; &amp; notify the team\n\nI sent you a link.",
    );
  });

  it("falls back to the generic notice without request text", () => {
    expect(buildAuthPauseResponse("U123", "GitHub")).toBe(
      "<@U123> I'll need you to authorize GitHub. I sent you a link.",
    );
  });
});
