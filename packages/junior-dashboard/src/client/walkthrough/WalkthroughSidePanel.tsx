import type { ReactNode } from "react";

import { DetailsPanel, useDetailsPanel } from "../components/DetailsPanel";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";

/** The tab the side panel shows. */
export type WalkthroughSideTab = "questions" | "review";

/** Count of open decisions, in the same badge as the navigation counts. */
export function CountBadge(props: { count: number; label: string }) {
  return (
    <span
      aria-label={props.label}
      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-dashboard-accent px-1 text-2xs font-semibold leading-none tabular-nums text-dashboard-text-inverse"
    >
      {props.count}
    </span>
  );
}

/**
 * Questions and the review, beside the story. On wide screens the panel
 * always shows, so the reader sees that they can ask at any step. On narrow
 * screens it opens as a sheet.
 */
export function WalkthroughSidePanel(props: {
  onSheetClose(): void;
  onTabChange(tab: WalkthroughSideTab): void;
  openCount: number;
  questions: ReactNode;
  review: ReactNode;
  sheetOpen: boolean;
  tab: WalkthroughSideTab;
}) {
  const panel = useDetailsPanel();
  const tabs = (
    <Tabs
      className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-0"
      onValueChange={(value: WalkthroughSideTab) => props.onTabChange(value)}
      value={props.tab}
    >
      <TabsList className="px-2" variant="line">
        <TabsTrigger value="questions">Questions</TabsTrigger>
        <TabsTrigger value="review">
          Review
          {props.openCount ? (
            <CountBadge
              count={props.openCount}
              label={`${props.openCount} not answered`}
            />
          ) : null}
        </TabsTrigger>
      </TabsList>
      <TabsContent className="grid min-h-0" value="questions">
        {props.questions}
      </TabsContent>
      <TabsContent
        className="thin-scrollbar min-h-0 overflow-y-auto overscroll-contain"
        value="review"
      >
        {props.review}
      </TabsContent>
    </Tabs>
  );

  if (panel) {
    return (
      <aside
        aria-label="Questions and review"
        className="grid min-h-0 min-w-0 border-l border-dashboard-border bg-dashboard-bg-elevated"
      >
        {tabs}
      </aside>
    );
  }
  if (!props.sheetOpen) return null;
  return (
    <DetailsPanel
      label="Questions and review"
      onClose={props.onSheetClose}
      sheetTitle="Walkthrough"
      title={null}
    >
      {tabs}
    </DetailsPanel>
  );
}
