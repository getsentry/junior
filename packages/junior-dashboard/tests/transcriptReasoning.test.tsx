import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TranscriptReasoningView } from "../src/client/conversations/TranscriptReasoningView";

describe("transcript reasoning", () => {
  it("renders a collapsed reasoning row with preview text", () => {
    const html = renderToStaticMarkup(
      <TranscriptReasoningView
        part={{
          type: "reasoning",
          text: "Inspect the inputs before searching.",
        }}
        timestamp={1_000}
      />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Reasoning"');
    expect(html).toContain("lucide-lightbulb");
    expect(html).not.toContain("lucide-brain");
    expect(html).toContain("Inspect the inputs before searching.");
  });
});
