import { SegmentedNav } from "../../components/SegmentedNav";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/ui/tabs";

/** Show `ui/tabs` switching the panel below them. */
export function TabsFixture() {
  return (
    <Tabs className="max-w-xs" defaultValue="summary">
      <TabsList activateOnFocus aria-label="Conversation panels">
        <TabsTrigger value="summary">Summary</TabsTrigger>
        <TabsTrigger value="memories">Memories</TabsTrigger>
        <TabsTrigger value="agents">Subagents</TabsTrigger>
      </TabsList>
      <TabsContent
        className="text-sm leading-relaxed text-dashboard-text-muted"
        value="summary"
      >
        Checkout latency increased after the latest release. Compare traces from
        before and after the deployment.
      </TabsContent>
      <TabsContent
        className="text-sm leading-relaxed text-dashboard-text-muted"
        value="memories"
      >
        What Junior learned from this conversation.
      </TabsContent>
      <TabsContent
        className="text-sm leading-relaxed text-dashboard-text-muted"
        value="agents"
      >
        Child conversations and their current work.
      </TabsContent>
    </Tabs>
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
