import { describe, expect, it } from "vitest";
import { buildAuthPauseResponse } from "@/chat/services/auth-pause-response";

describe("buildAuthPauseResponse", () => {
  it("escapes the reason, which can be agent-written text", () => {
    const text = buildAuthPauseResponse(
      "U123",
      "GitHub",
      "  Update <roadmap> & notify <!here>  ",
    );

    expect(text).toContain("Update &lt;roadmap&gt; &amp; notify &lt;!here&gt;");
    expect(text).not.toContain("<!here>");
  });
});
