import { useState } from "react";

import { SegmentedNav } from "../../components/SegmentedNav";
import { SegmentedTabs } from "../../components/SegmentedTabs";

/** Show panel tabs switching the panel below them. */
export function SegmentedTabsFixture() {
  const [tab, setTab] = useState<"summary" | "memories" | "agents">("summary");
  return (
    <div className="h-64 max-w-xs">
      <SegmentedTabs
        scroll
        items={[
          { label: "Summary", value: "summary" },
          { count: 3, label: "Memories", value: "memories" },
          { count: 2, label: "Subagents", value: "agents" },
        ]}
        label="Conversation panels"
        onChange={setTab}
        value={tab}
      >
        <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
          {tab === "summary"
            ? "Checkout latency increased after the latest release. Compare traces from before and after the deployment, then inspect the slow serialization span. The public brief links the affected repository, the release, and the open code change. Keep the rollout paused until the comparison confirms the cause. The next check is to run the same request against the previous release and compare its timings. Use the linked work to record the result and any rollback decision. The participants can continue this investigation in the conversation while keeping these details open. Model usage and related child conversations remain available in their own sections."
            : tab === "memories"
              ? "What Junior learned from this conversation."
              : "Child conversations and their current work."}
        </p>
      </SegmentedTabs>
    </div>
  );
}

const PAGE_LINKS = [
  "Overview",
  "People",
  "Locations",
  "Workspaces",
  "Plugins",
].map((label) => ({
  isActive: () => label === "Overview",
  label,
  to: `#${label.toLowerCase()}`,
}));

/** Show page links at label width, filling a row, and overflowing a row. */
export function SegmentedNavFixture() {
  return (
    <div className="grid gap-4">
      <SegmentedNav ariaLabel="Label width" items={PAGE_LINKS} />
      <div className="max-w-md">
        <SegmentedNav ariaLabel="Fill" fill items={PAGE_LINKS.slice(0, 2)} />
      </div>
      <div className="max-w-xs">
        <SegmentedNav ariaLabel="Overflow" fill items={PAGE_LINKS} />
      </div>
    </div>
  );
}
