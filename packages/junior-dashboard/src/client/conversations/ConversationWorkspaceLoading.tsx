import { Skeleton } from "../components/ui/skeleton";
import { dashboardContainerClass, cn } from "../styles";
import { ChatLayout } from "./ChatLayout";
import { composerDockClass } from "./ComposerDock";
import { ConversationHomeListLoading } from "./ConversationHomeList";
import { TranscriptLoading } from "./TranscriptLoading";

/**
 * Keep the conversation workspace geometry stable while its first data loads.
 * The app sidebar shows its own loading rows.
 */
export function ConversationWorkspaceLoading(props: { detail: boolean }) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={cn(
        dashboardContainerClass,
        "grid h-full min-h-0 grid-cols-[minmax(0,1fr)] overflow-hidden",
      )}
      role="status"
    >
      <span className="sr-only">
        {props.detail ? "Loading conversation" : "Loading conversations"}
      </span>
      {props.detail ? (
        <ConversationDetailLoading />
      ) : (
        <ConversationHomeLoading />
      )}
    </div>
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
          "border-t border-dashboard-border-subtle sm:px-6 md:grid md:max-h-none md:place-items-center md:border-t-0 md:px-6",
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
