import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TranscriptActivityGroup } from "../src/client/conversations/TranscriptActivityGroup";
import type { RenderedTranscriptEntry } from "../src/client/conversations/transcriptRenderModel";
import { TranscriptSearchProvider } from "../src/client/conversations/transcriptSearch";

function runningTool(): RenderedTranscriptEntry {
  return {
    key: "tool:live",
    kind: "tool",
    part: {
      id: "live",
      input: {},
      name: "bash",
      startedTimestamp: 1_000,
      status: "running",
      type: "tool_call",
    },
    timestamp: 1_000,
  };
}

describe("live transcript activity group", () => {
  it("shimmers the collapsed activity label while tools are running", () => {
    const html = renderToStaticMarkup(
      <TranscriptSearchProvider query="">
        <TranscriptActivityGroup
          entries={[runningTool()]}
          renderEntry={() => null}
        />
      </TranscriptSearchProvider>,
    );

    expect(html).toContain("junior-text-shimmer");
    expect(html).toContain("1 event");
    expect(html).not.toContain("animate-pulse rounded-full bg-cyan-300");
  });
});
