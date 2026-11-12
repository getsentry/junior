import { Skeleton } from "../components/ui/skeleton";
import { dashboardContainerClass, cn } from "../styles";
import { ChatLayout } from "./ChatLayout";
import { ListPane, usePaneOpen } from "../components/layout/PaneNav";
import { TranscriptLoading } from "./TranscriptLoading";

/** Keep the conversation workspace geometry stable while its first data loads. */
export function ConversationWorkspaceLoading(props: { detail: boolean }) {
  const sidebarOpen = usePaneOpen();
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={cn(
        dashboardContainerClass,
        "grid h-full min-h-0 grid-cols-[minmax(0,1fr)] overflow-hidden",
        sidebarOpen && "md:grid-cols-[auto_minmax(0,1fr)]",
      )}
      role="status"
    >
      <span className="sr-only">
        {props.detail ? "Loading conversation" : "Loading conversations"}
      </span>
      {sidebarOpen ? <ConversationSidebarLoading /> : null}
      {props.detail ? (
        <ConversationDetailLoading />
      ) : (
        <ConversationHomeLoading />
      )}
    </div>
  );
}

// Mirror the live pane so the first paint does not jump. The pane's
// destinations do not wait for data, so they show at once.
function ConversationSidebarLoading() {
  return (
    <ListPane className="max-md:hidden">
      <div
        aria-hidden="true"
        className="grid h-full content-start gap-1 border-r border-dashboard-border bg-dashboard-surface-panel px-3 pt-2"
      >
        {Array.from({ length: 7 }, (_, index) => (
          <div className="flex h-8 items-center gap-3 px-3" key={index}>
            <Skeleton className="size-4 rounded" />
            <Skeleton className={cn("h-3.5", index % 2 ? "w-20" : "w-28")} />
          </div>
        ))}
      </div>
    </ListPane>
  );
}

// The Inbox list: card rows in the main area.
function ConversationHomeLoading() {
  return (
    <div
      aria-hidden="true"
      className="mx-auto grid w-full max-w-[56rem] content-start gap-2 px-2 pt-4 md:px-6"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div
          className="grid gap-2 rounded-xl border border-dashboard-border px-4 py-3"
          key={index}
        >
          <Skeleton className={cn("h-4", index % 2 ? "w-2/5" : "w-3/5")} />
          <Skeleton className="h-3 w-4/5 opacity-70" />
        </div>
      ))}
    </div>
  );
}

function ConversationDetailLoading() {
  return (
    <section
      aria-label="Selected conversation"
      className="grid min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-dashboard-fill-faint"
    >
      <ChatLayout
        scrollAriaLabel="Conversation transcript"
        scrollClassName="thin-scrollbar px-4 pb-4 md:px-7 md:pb-6"
        scroll={
          <section className="min-w-0">
            <div className="mb-4 grid gap-3 border-b border-dashboard-border-subtle py-4">
              <Skeleton className="h-6 w-2/3 max-w-lg" />
              <Skeleton className="h-3 w-1/3 max-w-56 opacity-70" />
            </div>
            <div aria-hidden="true" className="mx-auto w-full max-w-[52.5rem]">
              <TranscriptLoading />
            </div>
          </section>
        }
      />
    </section>
  );
}
