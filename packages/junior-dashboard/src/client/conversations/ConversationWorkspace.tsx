import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Globe2, LockKeyhole } from "lucide-react";
import { useNavigate, useParams } from "react-router";

import { useConversationsData } from "../api";
import { ConversationSidebar } from "./ConversationSidebar";
import { ToggleButton } from "../components/Button";
import { ConversationComposer } from "./ConversationComposer";
import {
  useCreateConversation,
  usePendingArchiveConversationUpdates,
  type PendingArchiveConversationUpdate,
} from "./queries";
import { conversationPath, NEW_CONVERSATION_PATH } from "./conversationRoutes";
import { buildConversations, filterConversationList } from "../format";
import type { DashboardCoreData } from "../types";
import type { Conversation } from "../types";
import { cn, dashboardContainerClass } from "../styles";
import { ConversationPage } from "./ConversationPage";

/** Render the personal split-pane conversation workspace at the dashboard root. */
export function ConversationWorkspace(props: { data: DashboardCoreData }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"active" | "archived">("active");
  const params = useParams();
  const navigate = useNavigate();
  const selectedId = params.conversationId;
  // Home and create are one surface: no selected thread means the landing
  // (compose hero + list nav). Desktop already did this; mobile matches it.
  const landing = !selectedId;
  const feed = useConversationsData(status);
  const pendingArchiveUpdates = usePendingArchiveConversationUpdates();
  const createConversation = useCreateConversation();
  const conversations = useMemo(
    () =>
      applyPendingArchiveUpdates(
        buildConversations(feed.data?.conversations ?? []),
        pendingArchiveUpdates,
      ),
    [feed.data?.conversations, pendingArchiveUpdates],
  );
  const visibleConversations = useMemo(
    () =>
      filterConversationList(conversations, {
        actor: "",
        query,
        source: "",
        status,
      }),
    [conversations, query, status],
  );

  useEffect(() => {
    if (!landing) return;
    // New chats are active; leave archived view so the created row can appear.
    setStatus("active");
  }, [landing]);

  const openCreate = () => {
    createConversation.reset();
    setStatus("active");
    if (selectedId) navigate(NEW_CONVERSATION_PATH);
  };

  const createView = (
    <NewConversationView
      error={
        createConversation.error
          ? "Could not create the conversation. Try again."
          : undefined
      }
      onSubmit={async (message, idempotencyKey, visibility) => {
        const accepted = await createConversation.mutateAsync({
          idempotencyKey,
          message,
          visibility,
        });
        navigate(conversationPath(accepted.conversationId));
      }}
    />
  );

  // Landing (home + create): simple app header + compose hero + list nav on
  // mobile; desktop keeps the split pane. One create tree only — dual mounts
  // break focus/a11y queries.
  if (landing) {
    return (
      <div
        className={cn(
          dashboardContainerClass,
          "grid h-full min-h-0 overflow-hidden md:grid-cols-[21rem_minmax(0,1fr)] xl:border-x xl:border-white/[0.07]",
        )}
      >
        <div className="hidden h-full min-h-0 overflow-hidden md:block">
          <ConversationSidebar
            conversations={visibleConversations}
            error={feed.error?.message}
            loading={feed.isPending}
            onNewConversation={openCreate}
            onQueryChange={setQuery}
            onStatusChange={setStatus}
            query={query}
            selectedId={undefined}
            status={status}
            timeZone={props.data.config.timeZone}
          />
        </div>
        <section
          aria-label="New conversation"
          className="min-h-0 overflow-hidden bg-white/[0.012]"
        >
          <CreateLandingScroll
            hero={createView}
            list={
              <div className="md:hidden">
                <ConversationSidebar
                  conversations={visibleConversations}
                  error={feed.error?.message}
                  loading={feed.isPending}
                  onNewConversation={openCreate}
                  onQueryChange={setQuery}
                  onStatusChange={setStatus}
                  query={query}
                  selectedId={undefined}
                  status={status}
                  timeZone={props.data.config.timeZone}
                  variant="landing"
                />
              </div>
            }
          />
        </section>
      </div>
    );
  }

  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid h-full min-h-0 overflow-hidden md:grid-cols-[21rem_minmax(0,1fr)] xl:border-x xl:border-white/[0.07]",
      )}
    >
      <div className="hidden h-full min-h-0 overflow-hidden md:block">
        <ConversationSidebar
          conversations={visibleConversations}
          error={feed.error?.message}
          loading={feed.isPending}
          onNewConversation={openCreate}
          onQueryChange={setQuery}
          onStatusChange={setStatus}
          query={query}
          selectedId={selectedId}
          status={status}
          timeZone={props.data.config.timeZone}
        />
      </div>
      <section
        aria-label="Selected conversation"
        className="grid min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-white/[0.012]"
      >
        <ConversationPage
          key={selectedId}
          conversationId={selectedId}
          data={
            feed.data
              ? {
                  conversations: feed.data,
                }
              : undefined
          }
          pendingArchiveUpdate={pendingArchiveUpdates.find(
            (update) => update.conversationId === selectedId,
          )}
        />
      </section>
    </div>
  );
}


/**
 * Landing frame: non-scrolling hero above a list scroller.
 *
 * Keep the hero out of the overflow ancestor so iOS focus cannot pan it away.
 * List search owns the only scroll region under the hero.
 */
function CreateLandingScroll(props: {
  hero: ReactNode;
  list: ReactNode;
}) {
  return (
    <div
      // Mobile: pin hero above a list scroller. Desktop: one page scroller so
      // the hero can still center with min-h-full (list is md:hidden).
      className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden md:block md:overflow-y-auto md:overscroll-contain"
      data-create-landing-scroll=""
    >
      <div className="min-w-0 shrink-0 md:min-h-full">{props.hero}</div>
      <div
        className="min-h-0 min-w-0 overflow-y-auto overscroll-contain md:hidden"
        data-create-landing-list=""
      >
        {props.list}
      </div>
    </div>
  );
}

function NewConversationView(props: {
  error?: string;
  onSubmit(
    message: string,
    idempotencyKey: string,
    visibility: "private" | "public",
  ): Promise<void>;
}) {
  const [visibility, setVisibility] = useState<"private" | "public">("public");
  const isPublic = visibility === "public";

  // Landing-page compose hero. Parent owns page scroll and stacks conversation
  // nav under this block on mobile; desktop still centers the hero alone.
  return (
    <div
      className="px-4 py-10 md:flex md:min-h-full md:flex-col md:justify-center md:px-8 md:py-12"
      data-create-landing-hero=""
    >
      <div className="mx-auto flex w-full max-w-xl flex-col items-stretch gap-5 md:max-w-2xl md:gap-8">
          <h2 className="m-0 text-center font-display text-2xl font-medium tracking-[-0.03em] text-dashboard-text md:text-3xl">
            What do you need?
          </h2>
          <ConversationComposer
            draftId="new"
            error={props.error}
            footerStart={
              <div
                aria-label="Conversation visibility"
                className="inline-flex items-center gap-1"
                role="group"
              >
                <ToggleButton
                  onClick={() => setVisibility("public")}
                  pressed={isPublic}
                  type="button"
                  variant="segment"
                >
                  <Globe2 aria-hidden="true" className="mr-1 inline size-3" />
                  Public
                </ToggleButton>
                <ToggleButton
                  onClick={() => setVisibility("private")}
                  pressed={!isPublic}
                  type="button"
                  variant="segment"
                >
                  <LockKeyhole
                    aria-hidden="true"
                    className="mr-1 inline size-3"
                  />
                  Private
                </ToggleButton>
              </div>
            }
            label="Start a conversation"
            restoreDraftOnError
            submitLabel="Send"
            onSubmit={(message, idempotencyKey) =>
              props.onSubmit(message, idempotencyKey, visibility)
            }
          />
      </div>
    </div>
  );
}

function applyPendingArchiveUpdates(
  conversations: Conversation[],
  updates: PendingArchiveConversationUpdate[],
): Conversation[] {
  const byId = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
  for (const update of updates) {
    const existing = byId.get(update.conversationId);
    const conversation =
      existing ??
      (update.conversation
        ? buildConversations([update.conversation])[0]
        : undefined);
    if (!conversation) continue;
    byId.set(update.conversationId, {
      ...conversation,
      archivedAt: update.archived
        ? (conversation.archivedAt ?? conversation.lastSeenAt)
        : null,
    });
  }
  return [...byId.values()].sort((a, b) =>
    b.lastSeenAt.localeCompare(a.lastSeenAt),
  );
}
