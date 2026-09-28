import { Skeleton } from "../components/Skeleton";
import { cn } from "../styles";
import { ChatLayout } from "./ChatLayout";
import { ConversationHomeListLoading } from "./ConversationHomeList";

/** Keep the conversation workspace geometry stable while its first data loads. */
export function ConversationWorkspaceLoading(props: { detail: boolean }) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="grid h-full min-h-0 w-full overflow-hidden bg-dashboard-bg md:grid-cols-[20rem_minmax(0,1fr)]"
      role="status"
    >
      <span className="sr-only">
        {props.detail ? "Loading conversation" : "Loading conversations"}
      </span>
      <ConversationSidebarLoading />
      {props.detail ? (
        <ConversationDetailLoading />
      ) : (
        <ConversationHomeLoading />
      )}
    </div>
  );
}

function ConversationSidebarLoading() {
  return (
    <aside className="hidden h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden border-r border-dashboard-border-emphasis bg-dashboard-surface-panel md:grid">
      <div className="flex items-center justify-between gap-2 px-5 py-3">
        <h2 className="m-0 font-display text-lg font-medium leading-tight text-dashboard-text">
          Conversations
        </h2>
        <Skeleton className="size-7 rounded-md" />
      </div>
      <div className="px-4 pb-2">
        <Skeleton className="h-9 w-full rounded-lg border border-dashboard-border bg-dashboard-overlay-soft" />
      </div>
      <div className="grid content-start gap-1 px-3 pb-2">
        <Skeleton className="mb-1 ml-2.5 mt-1.5 h-2.5 w-12" />
        {Array.from({ length: 7 }, (_, index) => (
          <div className="grid gap-2 rounded-md px-2.5 py-2" key={index}>
            <Skeleton
              className={cn("h-3", index % 3 === 0 ? "w-4/5" : "w-3/5")}
            />
            <Skeleton className="h-2.5 w-2/5 opacity-70" />
          </div>
        ))}
      </div>
    </aside>
  );
}

function ConversationHomeLoading() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-6 md:p-8">
      <div className="mx-auto grid w-full max-w-6xl gap-8 md:my-auto">
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
      className="grid min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-dashboard-bg"
    >
      <ChatLayout
        scrollAriaLabel="Conversation transcript"
        scrollClassName="px-3 pb-1.5 md:px-7 md:pb-2"
        scroll={
          <section className="min-w-0">
            <div className="mb-4 grid gap-3 border-b border-dashboard-border-subtle py-4">
              <Skeleton className="h-6 w-2/3 max-w-lg" />
              <Skeleton className="h-3 w-1/3 max-w-56 opacity-70" />
            </div>
            <div className="grid gap-6 py-2">
              <MessageLoading align="start" />
              <ActivityLoading />
              <MessageLoading align="end" />
              <MessageLoading align="start" />
            </div>
          </section>
        }
      />
    </section>
  );
}

function MessageLoading(props: { align: "end" | "start" }) {
  return (
    <div
      className={cn("grid gap-2", props.align === "end" && "justify-items-end")}
    >
      <Skeleton className="h-3 w-24 opacity-70" />
      <Skeleton
        className={cn("h-4", props.align === "end" ? "w-56" : "w-3/4 max-w-xl")}
      />
      <Skeleton className="h-4 w-2/3 max-w-lg" />
    </div>
  );
}

function ActivityLoading() {
  return (
    <div className="grid gap-2 border-l border-dashboard-border-subtle py-1 pl-4">
      <Skeleton className="h-3 w-36 opacity-70" />
      <Skeleton className="h-3 w-1/2 max-w-sm" />
    </div>
  );
}
