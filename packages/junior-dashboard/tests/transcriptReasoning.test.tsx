import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TranscriptReasoningView } from "../src/client/conversations/TranscriptReasoningView";
import { TranscriptSearchProvider } from "../src/client/conversations/transcriptSearch";

describe("transcript reasoning", () => {
  it("renders a collapsed reasoning row with preview text", () => {
    const html = renderToStaticMarkup(
      <TranscriptSearchProvider query="">
        <TranscriptReasoningView
          part={{
            type: "reasoning",
            text: "Inspect the inputs before searching.",
          }}
          timestamp={1_000}
        />
      </TranscriptSearchProvider>,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Reasoning"');
    expect(html).toContain("lucide-lightbulb");
    expect(html).not.toContain("lucide-brain");
    expect(html).toContain("Inspect the inputs before searching.");
  });

  it("expands matching reasoning while transcript search is active", () => {
    const html = renderToStaticMarkup(
      <TranscriptSearchProvider query="inputs">
        <TranscriptReasoningView
          part={{
            type: "reasoning",
            text: "Inspect the inputs before searching.",
          }}
        />
      </TranscriptSearchProvider>,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("<mark");
    expect(html).toContain("inputs");
    expect(html.match(/Inspect the /g)).toHaveLength(1);
  });
});
