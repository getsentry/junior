import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { TranscriptContextEventView } from "../src/client/components/TranscriptContextEventView";

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
            },
          }}
          timestamp={Date.parse("2026-01-01T00:00:02.000Z")}
        />,
      ),
    );

    expect(html).toContain("Context compacted");
    expect(html).toContain("Earlier context was summarized");
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
            },
          }}
        />,
      ),
    );

    expect(html).toContain("Model handoff");
    expect(html).toContain("Execution continued with a different model.");
  });
});
