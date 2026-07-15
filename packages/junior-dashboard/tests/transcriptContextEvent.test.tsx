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
  it("renders compaction without the private summary or model", () => {
    const html = renderToStaticMarkup(
      withQueryClient(
        <TranscriptContextEventView
          part={{
            type: "context_event",
            event: {
              type: "context_compacted",
              createdAt: "2026-01-01T00:00:02.000Z",
            },
          }}
          timestamp={Date.parse("2026-01-01T00:00:02.000Z")}
        />,
      ),
    );

    expect(html).toContain("Context compacted");
    expect(html).toContain("Earlier context was summarized");
    expect(html).not.toContain("gpt-5.4");
    expect(html).not.toContain("Earlier release checks passed.");
  });

  it("renders a structural model handoff without raw context", () => {
    const html = renderToStaticMarkup(
      withQueryClient(
        <TranscriptContextEventView
          part={{
            type: "context_event",
            event: {
              type: "model_handoff",
              createdAt: "2026-01-01T00:00:04.000Z",
            },
          }}
        />,
      ),
    );

    expect(html).toContain("Model handoff");
    expect(html).toContain("Execution continued with a different model.");
    expect(html).not.toContain("gpt-5.4");
    expect(html).not.toContain("gpt-5.6-sol");
    expect(html).not.toContain("Continue with the migration fix.");
  });

  it("does not reveal transition payload while search is active", () => {
    const html = renderToStaticMarkup(
      withQueryClient(
        <TranscriptSearchProvider query="release checks">
          <TranscriptContextEventView
            part={{
              type: "context_event",
              event: {
                type: "context_compacted",
                createdAt: "2026-01-01T00:00:02.000Z",
              },
            }}
          />
        </TranscriptSearchProvider>,
      ),
    );

    expect(html).toContain("Context compacted");
    expect(html).not.toContain("Earlier release checks passed.");
    expect(html).not.toContain("<mark");
  });
});
