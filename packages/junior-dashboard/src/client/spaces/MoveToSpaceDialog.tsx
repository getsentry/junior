import { lazy, Suspense } from "react";
import type { SpaceRefReport } from "@sentry/junior/api/schema";

// The dialog opens only after a click, so cmdk loads with the first open
// instead of with the page.
const MoveToSpaceDialogContent = lazy(() =>
  import("./MoveToSpaceDialogContent").then((module) => ({
    default: module.MoveToSpaceDialogContent,
  })),
);

/** What opens the Move to Space dialog. */
export type MoveToSpaceDialogProps = {
  conversationId: string;
  current: SpaceRefReport | null;
  onClose(): void;
};

/**
 * Pick the Space of a top-level Conversation, or no Space. The viewer can
 * move work only into a Space that they are a member of, so the list shows
 * those, and the current Space.
 */
export function MoveToSpaceDialog(props: MoveToSpaceDialogProps) {
  return (
    <Suspense fallback={null}>
      <MoveToSpaceDialogContent {...props} />
    </Suspense>
  );
}
