import type { ReactNode } from "react";

import { DetailsPanel, useDetailsPanel } from "../components/DetailsPanel";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import { WalkthroughQuestions } from "./WalkthroughQuestions";

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

const asideClass =
  "grid min-h-0 min-w-0 border-l border-dashboard-border bg-dashboard-bg-elevated";

/**
 * Questions alone, for a version that is not ready, so it takes no questions
 * and has no review yet. Wide screens only.
 */
export function WalkthroughQuestionsPanel() {
  const panel = useDetailsPanel();
  if (!panel) return null;
  return (
    <aside
      aria-label="Questions"
      className={`${asideClass} grid-rows-[auto_minmax(0,1fr)]`}
    >
      <h2 className="m-0 border-b border-dashboard-border-subtle px-4 py-3 font-sans text-sm font-semibold text-dashboard-text">
        Questions
      </h2>
      <WalkthroughQuestions />
    </aside>
  );
}

/**
 * Questions and the review, beside the story. On wide screens the panel
 * always shows, so the reviewer sees that they can ask at any chapter. On
 * narrow screens it opens as a sheet.
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
              label={`${props.openCount} open`}
            />
          ) : null}
        </TabsTrigger>
      </TabsList>
      <TabsContent className="grid min-h-0" value="questions">
        {props.questions}
      </TabsContent>
      {/* The review owns its scroll, so Copy review stays at the bottom. */}
      <TabsContent className="grid min-h-0 min-w-0" value="review">
        {props.review}
      </TabsContent>
    </Tabs>
  );

  if (panel) {
    return (
      <aside aria-label="Questions and review" className={asideClass}>
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
