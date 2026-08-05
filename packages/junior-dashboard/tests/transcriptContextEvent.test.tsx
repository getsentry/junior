import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { TranscriptContextEventView } from "../src/client/conversations/TranscriptContextEventView";

function withQueryClient(children: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

describe("transcript context events", () => {
  it("renders compaction as a structural event", () => {
    const html = renderToStaticMarkup(
      withQueryClient(
        <TranscriptContextEventView
          part={{
            type: "context_event",
            event: {
              type: "compaction",
              createdAt: "2026-01-01T00:00:02.000Z",
              modelProfile: "standard",
              modelId: "openai/gpt-5.4",
              summary: "Preserve the release state and monitor **CI**.",
              details: {
                reason: "capacity",
                estimatedInputTokens: 361_000,
                replacementInputTokens: 2_400,
                triggerTokens: 360_000,
                inputLimitTokens: 380_000,
                inputMessageCount: 42,
                retainedMessageCount: 2,
                summaryChars: 1_200,
              },
            },
          }}
          timestamp={Date.parse("2026-01-01T00:00:02.000Z")}
        />,
      ),
    );

    expect(html).toContain("Context compacted");
    expect(html).toContain("approximately 361k estimated tokens");
    expect(html).toContain("standard profile (openai/gpt-5.4)");
    expect(html).toContain("Continuation summary");
    expect(html).toContain("Preserve the release state and monitor");
    expect(html).toContain("CI");
  });

  it("renders a model handoff as a structural event", () => {
    const html = renderToStaticMarkup(
      withQueryClient(
        <TranscriptContextEventView
          part={{
            type: "context_event",
            event: {
              type: "handoff",
              createdAt: "2026-01-01T00:00:04.000Z",
              modelId: "openai/gpt-5.4",
              modelProfile: "coding",
              reasoningLevel: "high",
              summary: "Continue the implementation from the failing test.",
            },
          }}
        />,
      ),
    );

    expect(html).toContain("Model handoff");
    expect(html).toContain(
      "Execution continued with the coding profile (openai/gpt-5.4, high).",
    );
    expect(html).toContain("Continuation summary");
    expect(html).toContain(
      "Continue the implementation from the failing test.",
    );
  });
});
