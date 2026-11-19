import { lazy, Suspense } from "react";

// The dialog opens only after a click, so cmdk loads with the first open
// instead of with the page.
const ContinueInSlackDialogContent = lazy(() =>
  import("./ContinueInSlackDialogContent").then((module) => ({
    default: module.ContinueInSlackDialogContent,
  })),
);

/** What opens the Continue in Slack dialog. */
export type ContinueInSlackDialogProps = {
  conversationId: string;
  onClose(): void;
};

/**
 * Move a public dashboard conversation to a thread in a public Slack channel
 * that Junior already knows.
 */
export function ContinueInSlackDialog(props: ContinueInSlackDialogProps) {
  return (
    <Suspense fallback={null}>
      <ContinueInSlackDialogContent {...props} />
    </Suspense>
  );
}
