import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkspaceUsageChart } from "../src/client/components/charts/WorkspaceUsageChart";

describe("WorkspaceUsageChart", () => {
  it("renders period totals and empty state copy", () => {
    const empty = renderToStaticMarkup(
      <WorkspaceUsageChart
        days={[
          { count: 0, date: "2026-07-26" },
          { count: 0, date: "2026-07-27" },
          { count: 0, date: "2026-07-28" },
        ]}
        range={7}
        workspaceName="sentry"
      />,
    );
    expect(empty).toContain("Usage");
    expect(empty).toContain("No usage in this period.");
    expect(empty).toContain(
      'aria-label="Usage for sentry during the last 7 days"',
    );

    const populated = renderToStaticMarkup(
      <WorkspaceUsageChart
        days={[
          { count: 0, date: "2026-07-26" },
          { count: 2, date: "2026-07-27" },
          { count: 4, date: "2026-07-28" },
        ]}
        range={7}
        workspaceName="sentry"
      />,
    );
    expect(populated).toContain(">6</div>");
    expect(populated).toContain("last 7 days");
    expect(populated).toContain('aria-label="Jul 28: 4 switches"');
    expect(populated).not.toContain("No usage in this period.");
  });
});
