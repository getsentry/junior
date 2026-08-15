import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StatsReport, WorkspaceReport } from "@sentry/junior/api/schema";

import { WorkspaceDetails } from "../src/client/pages/system/WorkspaceDetails";

const workspace: WorkspaceReport = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "sentry",
  repos: [],
  setupScript: "",
  snapshot: null,
};

function render(client: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <WorkspaceDetails range={30} workspace={workspace} />
    </QueryClientProvider>,
  );
}

describe("WorkspaceDetails", () => {
  it("keeps pending stats distinct from empty usage", () => {
    const pending = render(new QueryClient());
    expect(pending).toContain("Loading Workspace usage.");
    expect(pending).not.toContain("No usage in this period.");

    const loadedClient = new QueryClient();
    loadedClient.setQueryData<StatsReport>(
      ["dashboard", "stats", "workspace-switch"],
      {
        generatedAt: "2026-08-15T12:00:00.000Z",
        stats: [],
        windowEnd: "2026-08-15",
        windowStart: "2026-05-18",
      },
    );
    expect(render(loadedClient)).toContain("No usage in this period.");
  });
});
