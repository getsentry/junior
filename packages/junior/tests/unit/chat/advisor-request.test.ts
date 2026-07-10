import { describe, expect, it } from "vitest";

import {
  renderAdvisorRequest,
  unwrapAdvisorRequest,
} from "@/chat/advisor-request";

describe("advisor request", () => {
  it("round trips XML-sensitive task and context text", () => {
    const request = renderAdvisorRequest(
      'Review <change> & "risk".',
      "Use owner='dashboard' & preserve <context>.",
    );

    expect(request).toContain("Review &lt;change&gt; &amp; &quot;risk&quot;.");
    expect(unwrapAdvisorRequest(request)).toBe(
      `Review <change> & "risk".\n\nExecutor context:\nUse owner='dashboard' & preserve <context>.`,
    );
  });
});
