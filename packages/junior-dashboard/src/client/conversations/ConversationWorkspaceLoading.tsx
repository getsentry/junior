import type { CSSProperties } from "react";

import { Skeleton } from "../components/ui/skeleton";
import { dashboardContainerClass, cn } from "../styles";
import { ChatLayout } from "./ChatLayout";
import { ConversationHomeListLoading } from "./ConversationHomeList";
import { ConversationRowSkeletons } from "./ConversationSidebar";
import {
  readSidebarWidth,
  useConversationSidebarOpen,
} from "./conversationSidebarLayout";
import { TranscriptLoading } from "./TranscriptLoading";

/** Keep the conversation workspace geometry stable while its first data loads. */
export function ConversationWorkspaceLoading(props: { detail: boolean }) {
  const [sidebarOpen] = useConversationSidebarOpen();
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

// Mirror the live sidebar chrome so the first paint does not jump.
function ConversationSidebarLoading() {
  return (
    <aside className="hidden h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-r border-dashboard-border bg-dashboard-surface-panel md:grid">
      <div className="px-3 pb-1.5 pt-2.5">
        <div className="grid grid-cols-[0.875rem_minmax(0,1fr)] items-center gap-2 px-3 py-2 text-sm leading-snug">
          <Skeleton className="size-5 justify-self-center rounded-md" />
          <span className="flex h-[1lh] items-center">
            <Skeleton className="h-3 w-28" />
          </span>
        </div>
      </div>
      <div className="min-h-0 overflow-hidden px-3">
        <ConversationRowSkeletons />
      </div>
    </aside>
  );
}

// Wide screens show only the create view beside the list. Narrow screens
// stack the create view above the home list.
function ConversationHomeLoading() {
  return (
    <div className="h-full min-h-0 w-full overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-6 md:grid md:place-items-center md:py-13">
      <div className="mx-auto grid w-full max-w-6xl gap-8">
        <section className="mx-auto grid w-full max-w-3xl gap-3">
          <Skeleton className="mx-auto h-8 w-56" />
          <div className="w-full rounded-xl border border-dashboard-border-subtle bg-dashboard-surface-raised p-3">
            <Skeleton className="h-20 w-full bg-dashboard-fill-faint" />
            <div className="mt-3 flex justify-between">
              <Skeleton className="h-7 w-32" />
              <Skeleton className="size-8 rounded-md" />
            </div>
          </div>
        </section>
        <section className="grid gap-3 md:hidden">
          <Skeleton className="h-9 w-full rounded-lg border border-dashboard-border bg-dashboard-overlay-soft sm:ml-auto sm:w-72" />
          <ConversationHomeListLoading />
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
