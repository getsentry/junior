import type { CSSProperties } from "react";

import { Skeleton } from "../components/ui/skeleton";
import { dashboardContainerClass, cn } from "../styles";
import { ChatLayout } from "./ChatLayout";
import { composerDockClass } from "./ComposerDock";
import { ConversationHomeListLoading } from "./ConversationHomeList";
import { ConversationRowSkeletons } from "./ConversationSidebar";
import { readSidebarWidth } from "./conversationSidebarLayout";
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
        sidebarOpen &&
          "md:grid-cols-[var(--conversation-sidebar-width)_minmax(0,1fr)]",
      )}
      role="status"
      style={
        {
          "--conversation-sidebar-width": `${readSidebarWidth()}px`,
        } as CSSProperties
      }
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
      <aside className="h-full min-h-0 overflow-hidden border-r border-dashboard-border bg-dashboard-surface-panel px-3 pt-1.5">
        <ConversationRowSkeletons />
      </aside>
    </ListPane>
  );
}

// Wide screens show only the create view beside the list. Narrow screens
// show the home list with the create composer docked below it.
function ConversationHomeLoading() {
  return (
    <div className="grid h-full min-h-0 w-full grid-rows-[minmax(0,1fr)_auto] overflow-hidden md:grid-rows-[minmax(0,1fr)]">
      <section className="grid min-h-0 content-start gap-3 overflow-hidden px-4 pb-3 pt-4 sm:px-6 md:hidden">
        <Skeleton className="h-9 w-full rounded-lg border border-dashboard-border bg-dashboard-overlay-soft sm:ml-auto sm:w-72" />
        <ConversationHomeListLoading />
      </section>
      <div
        className={cn(
          composerDockClass,
          "border-t border-dashboard-border-subtle sm:px-6 md:grid md:max-h-none md:place-items-center md:border-t-0 md:px-6 md:pb-13 md:pt-13",
        )}
      >
        <section className="mx-auto grid w-full max-w-3xl gap-3">
          <Skeleton className="mx-auto hidden h-8 w-56 md:block" />
          <div className="w-full rounded-xl border border-dashboard-border-subtle bg-dashboard-surface-raised p-3">
            <Skeleton className="h-20 w-full bg-dashboard-fill-faint" />
            <div className="mt-3 flex justify-between">
              <Skeleton className="h-7 w-32" />
              <Skeleton className="size-8 rounded-md" />
            </div>
          </div>
        </section>
      </div>
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
