import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { TranscriptContextEventView } from "../src/client/components/TranscriptContextEventView";
import { TranscriptSearchProvider } from "../src/client/components/transcriptSearch";

function withQueryClient(children: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

describe("transcript context events", () => {
  it("renders compaction as a compact expandable event", () => {
    const html = renderToStaticMarkup(
      withQueryClient(
        <TranscriptContextEventView
          part={{
            type: "context_event",
            event: {
              type: "context_compacted",
              createdAt: "2026-01-01T00:00:02.000Z",
              modelId: "openai/gpt-5.4",
              summary: "Earlier release checks passed.",
              transcriptIndex: 0,
            },
          }}
          timestamp={Date.parse("2026-01-01T00:00:02.000Z")}
        />,
      ),
    );

    expect(html).toContain("Context compacted");
    expect(html).toContain("gpt-5.4");
    expect(html).toContain("View summary");
    expect(html).toContain("Earlier release checks passed.");
  });

  it("renders a model handoff with source, destination, and markdown summary", () => {
    const html = renderToStaticMarkup(
      withQueryClient(
        <TranscriptContextEventView
          part={{
            type: "context_event",
            event: {
              type: "model_handoff",
              createdAt: "2026-01-01T00:00:04.000Z",
              fromModelId: "openai/gpt-5.4",
              toModelId: "openai/gpt-5.6-sol",
              summary: "**Next:** Continue with the migration fix.",
              transcriptIndex: 0,
            },
          }}
        />,
      ),
    );

    expect(html).toContain("Model handoff");
    expect(html).toContain("gpt-5.4");
    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain("**Next:**");
    expect(html).toContain("Next:");
    expect(html).toContain("Continue with the migration fix.");
  });

  it("reveals a transition summary while transcript search is active", () => {
    const html = renderToStaticMarkup(
      withQueryClient(
        <TranscriptSearchProvider query="release checks">
          <TranscriptContextEventView
            part={{
              type: "context_event",
              event: {
                type: "context_compacted",
                createdAt: "2026-01-01T00:00:02.000Z",
                summary: "Earlier release checks passed.",
                transcriptIndex: 0,
              },
            }}
          />
        </TranscriptSearchProvider>,
      ),
    );

    expect(html).toContain("<details");
    expect(html).toContain('open=""');
    expect(html).toContain("<mark");
  });
});
