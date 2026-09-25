import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StatsReport, WorkspaceReport } from "@sentry/junior/api/schema";

import { WorkspaceDetailsContent } from "../src/client/pages/system/WorkspaceDetails";

const workspace: WorkspaceReport = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "sentry",
  repos: [],
  setupScript: "",
  snapshot: null,
};

const emptyStats: StatsReport = {
  generatedAt: "2026-08-15T12:00:00.000Z",
  stats: [],
  windowEnd: "2026-08-15",
  windowStart: "2026-05-18",
};

function render(props: {
  error?: boolean;
  loading?: boolean;
  stats?: StatsReport;
}): string {
  return renderToStaticMarkup(
    <WorkspaceDetailsContent
      error={props.error ?? false}
      loading={props.loading ?? false}
      range={30}
      stats={props.stats}
      workspace={workspace}
    />,
  );
}

describe("WorkspaceDetailsContent", () => {
  it("keeps pending, empty, failed, and stale refresh states distinct", () => {
    const pending = render({ loading: true });
    expect(pending).toContain("Loading Workspace usage.");
    expect(pending).not.toContain("No usage in this period.");
    expect(pending).not.toContain("Workspace usage failed to load.");

    const empty = render({ stats: emptyStats });
    expect(empty).toContain("No usage in this period.");
    expect(empty).not.toContain("Loading Workspace usage.");
    expect(empty).not.toContain("Workspace usage failed to load.");
    expect(empty).not.toContain(
      "Workspace usage refresh failed. Showing cached data.",
    );

    const failed = render({ error: true });
    expect(failed).toContain("Workspace usage failed to load.");
    expect(failed).not.toContain("Loading Workspace usage.");
    expect(failed).not.toContain("No usage in this period.");

    const stale = render({ error: true, stats: emptyStats });
    expect(stale).toContain(
      "Workspace usage refresh failed. Showing cached data.",
    );
    expect(stale).toContain("No usage in this period.");
    expect(stale).not.toContain("Workspace usage failed to load.");
    expect(stale).not.toContain("Loading Workspace usage.");
  });
});
