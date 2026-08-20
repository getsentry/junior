import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
          <CreateLandingScroll>
            {createView}
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
          </CreateLandingScroll>
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
 * Keep create-landing scroll stable while the hero composer is focused.
 *
 * iOS Safari scrolls the nearest overflow ancestor to center a focused field.
 * On this landing page that yanks the hero/list upward as the keyboard opens.
 * Freeze only for the hero composer — list search and other fields must keep
 * normal scroll so they stay on-screen while focused.
 */
function CreateLandingScroll(props: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const freezeScrollTopRef = useRef(0);
  const focusedRef = useRef(false);

  const isHeroComposerTarget = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    Boolean(target.closest("[data-create-landing-hero]")) &&
    (target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable);

  const lockToFrozenTop = useCallback(() => {
    const root = rootRef.current;
    if (!root || !focusedRef.current) return;
    if (root.scrollTop !== freezeScrollTopRef.current) {
      root.scrollTop = freezeScrollTopRef.current;
    }
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onFocusIn = (event: FocusEvent) => {
      if (!isHeroComposerTarget(event.target)) return;
      focusedRef.current = true;
      // Always pin landing to the hero while the composer is focused. Capturing
      // scrollTop after Safari's pan would freeze the jumped position.
      freezeScrollTopRef.current = 0;
      root.style.overflowY = "hidden";
      root.scrollTop = 0;
      requestAnimationFrame(lockToFrozenTop);
      queueMicrotask(lockToFrozenTop);
    };

    const onFocusOut = (event: FocusEvent) => {
      if (!isHeroComposerTarget(event.target)) return;
      // Stay frozen while focus moves inside the hero compose stack.
      const next = event.relatedTarget;
      if (next instanceof Node && isHeroComposerTarget(next)) {
        return;
      }
      focusedRef.current = false;
      root.style.overflowY = "";
      root.scrollTop = freezeScrollTopRef.current;
    };

    const onScroll = () => {
      if (!focusedRef.current) return;
      lockToFrozenTop();
    };

    // Prefer preventScroll focus on pointer so iOS never starts its focus pan.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!isHeroComposerTarget(target)) return;
      if (!(target instanceof HTMLElement) || document.activeElement === target) {
        return;
      }
      event.preventDefault();
      focusedRef.current = true;
      // Hero compose owns the top of this page. Keep scroll at 0 while typing.
      freezeScrollTopRef.current = 0;
      root.style.overflowY = "hidden";
      target.focus({ preventScroll: true });
      root.scrollTop = 0;
      requestAnimationFrame(lockToFrozenTop);
    };

    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener("scroll", onScroll);
    };
  }, [lockToFrozenTop]);

  return (
    <div
      className="h-full min-h-0 overflow-y-auto overscroll-contain"
      data-create-landing-scroll=""
      ref={rootRef}
    >
      {props.children}
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
        : undefined,
    });
  }
  return [...byId.values()].sort((a, b) =>
    b.lastSeenAt.localeCompare(a.lastSeenAt),
  );
}
