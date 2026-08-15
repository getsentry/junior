import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkspaceSwitchChart } from "../src/client/pages/system/WorkspaceSwitchChart";

describe("WorkspaceSwitchChart", () => {
  it("renders period totals and empty state copy", () => {
    const empty = renderToStaticMarkup(
      <WorkspaceSwitchChart
        days={[
          { count: 0, date: "2026-07-26" },
          { count: 0, date: "2026-07-27" },
          { count: 0, date: "2026-07-28" },
        ]}
        range={3}
        workspaceName="sentry"
      />,
    );
    expect(empty).toContain("Workspace switches");
    expect(empty).toContain("No Workspace switches in this period.");
    expect(empty).toContain(
      'aria-label="Workspace switches for sentry during the last 3 days"',
    );

    const populated = renderToStaticMarkup(
      <WorkspaceSwitchChart
        days={[
          { count: 0, date: "2026-07-26" },
          { count: 2, date: "2026-07-27" },
          { count: 4, date: "2026-07-28" },
        ]}
        range={3}
        workspaceName="sentry"
      />,
    );
    expect(populated).toContain(">6</div>");
    expect(populated).toContain("last 3 days");
    expect(populated).toContain('aria-label="Jul 28: 4 switches"');
    expect(populated).not.toContain("No Workspace switches in this period.");
  });
});
