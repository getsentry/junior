import { useState } from "react";

import { SegmentedNav } from "../../components/SegmentedNav";
import { SegmentedTabs } from "../../components/SegmentedTabs";

/** Show panel tabs switching the panel below them. */
export function SegmentedTabsFixture() {
  const [tab, setTab] = useState<"details" | "memories" | "usage">("details");
  return (
    <div className="max-w-md">
      <SegmentedTabs
        items={[
          { label: "Details", value: "details" },
          { label: "Memories", value: "memories" },
          { label: "Usage", value: "usage" },
        ]}
        label="Conversation panels"
        onChange={setTab}
        value={tab}
      >
        <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
          {tab === "details"
            ? "Conversation summary and linked work."
            : tab === "memories"
              ? "What Junior learned from this conversation."
              : "Time, tokens, and cost for this conversation."}
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
