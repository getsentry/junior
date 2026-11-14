import { GitFork } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { getDashboardAgentName } from "../agentName";
import { useDashboardCoreData } from "../api";
import { ClampedPreview } from "../components/ClampedPreview";
import { DetailsPanel } from "../components/DetailsPanel";
import { ShimmerText } from "../components/ShimmerText";
import { Button } from "../components/ui/button";
import { DisplayText } from "../display-text/DisplayText";
import { DashboardApiError, post } from "../http";
import {
  acceptedConversationMessageSchema,
  forkConversationResponseSchema,
  type ConversationDetailReport,
} from "@sentry/junior/api/schema";
import { cn } from "../styles";
import { ConversationComposer } from "./ConversationComposer";
import { conversationPath } from "./conversationRoutes";
import {
  conversationDetailQueryKey,
  conversationDetailQueryOptions,
} from "./queries";
import {
  isDeliberateSelection,
  markdownQuote,
  selectionMarkdown,
} from "./selectionQuote";
import { TranscriptMessageShell } from "./TranscriptMessageShell";

const HIGHLIGHT_NAME = "quick-question";
const STARTER_PROMPTS = ["Explain this", "Is this right?", "What's the risk?"];
const QUOTE_PREVIEW_LINES = 5;

type QuickQuestionMessage = { role: "user" | "assistant"; text: string };

/** The selected text in one Junior reply. */
type QuickQuestionSelection = {
  messageId: string;
  quote: string;
  range: Range;
};

type QuickQuestionThread = QuickQuestionSelection & {
  conversationId: string;
  /** Hidden fork that the first question starts. */
  forkId?: string;
  id: string;
  /** Questions sent from this page, shown until the fork history has them. */
  asked: string[];
  askedAtMs?: number;
};

/** Show or clear the selection highlight. Browsers without the API skip it. */
function setHighlight(range: Range | undefined) {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  if (range) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
  else CSS.highlights.delete(HIGHLIGHT_NAME);
}

/** Longest quote the API accepts. Longer selections are clipped. */
const MAX_QUOTE_CHARS = 4_000;

/**
 * Read the selection when it lies in the text of one Junior reply that can
 * end a fork. `TranscriptMessageView` marks that text.
 */
function readSelection(
  root: HTMLElement | null,
): QuickQuestionSelection | undefined {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount)
    return undefined;
  const quote = selection.toString().trim().slice(0, MAX_QUOTE_CHARS).trim();
  if (!isDeliberateSelection(quote)) return undefined;
  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const element = node instanceof Element ? node : node.parentElement;
  const message = element?.closest<HTMLElement>(
    "[data-quick-question-message-id]",
  );
  const messageId = message?.dataset["quickQuestionMessageId"];
  if (!message || !messageId || !root.contains(message)) return undefined;
  return { messageId, quote, range: range.cloneRange() };
}

// Touch selection ends with no mouseup, and iOS moves the selection while
// the reader drags its handles. Show the menu once the selection holds still.
const SELECTION_SETTLE_MS = 300;
// On touch, iOS shows its own menu above the selection and a drag handle
// below it. Keep the buttons clear of both.
const TOUCH_GAP_PX = 24;

/** The selection that the menu acts on, and where the menu shows. */
type SelectionMenu = {
  rect: DOMRect;
  selection: QuickQuestionSelection;
  touch: boolean;
};

function sameRange(a: Range, b: Range): boolean {
  return (
    a.compareBoundaryPoints(Range.START_TO_START, b) === 0 &&
    a.compareBoundaryPoints(Range.END_TO_END, b) === 0
  );
}

/**
 * Show "Quick question" and "Respond" buttons next to a text selection in a
 * Junior reply. A scroll hides them until the selection settles again.
 */
export function QuickQuestionSelectionButton(props: {
  rootRef: RefObject<HTMLElement | null>;
  onAsk(selection: QuickQuestionSelection): void;
  /** Take the selection as a Markdown quote. Absent without a message box. */
  onRespond?(quote: string): void;
}) {
  const { rootRef, onAsk, onRespond } = props;
  const [menu, setMenu] = useState<SelectionMenu>();
  const shownRef = useRef<SelectionMenu>(undefined);
  // A tap can clear the selection before its click. Until a new press, ignore
  // the selection events that the tap sends, and keep the menu.
  const pressingMenuRef = useRef(false);
  const place = useCallback((next: SelectionMenu | undefined) => {
    shownRef.current = next;
    setMenu(next);
  }, []);
  useEffect(() => {
    let timer: number | undefined;
    let touch = false;
    // A mouse drag shows the menu on mouseup, not when it pauses.
    let mousePressed = false;
    const show = () => {
      if (pressingMenuRef.current) return;
      window.clearTimeout(timer);
      const selection = readSelection(rootRef.current);
      place(
        selection && {
          rect: selection.range.getBoundingClientRect(),
          selection,
          touch,
        },
      );
    };
    const hideUntilSettled = () => {
      if (pressingMenuRef.current) return;
      place(undefined);
      window.clearTimeout(timer);
      if (!mousePressed) timer = window.setTimeout(show, SELECTION_SETTLE_MS);
    };
    const onSelectionChange = () => {
      if (pressingMenuRef.current) return;
      const next = readSelection(rootRef.current);
      if (!next) {
        window.clearTimeout(timer);
        place(undefined);
      } else if (
        !shownRef.current ||
        !sameRange(shownRef.current.selection.range, next.range)
      ) {
        hideUntilSettled();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      touch = event.pointerType !== "mouse";
      mousePressed = event.pointerType === "mouse";
      // The menu sets this again in its own handler, which runs later.
      pressingMenuRef.current = false;
    };
    const onPointerUp = () => {
      mousePressed = false;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    document.addEventListener("mouseup", show);
    document.addEventListener("keyup", show);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("scroll", hideUntilSettled, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);
      document.removeEventListener("mouseup", show);
      document.removeEventListener("keyup", show);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("scroll", hideUntilSettled, true);
    };
  }, [place, rootRef]);
  const menuRef = useRef<HTMLDivElement>(null);
  // Keep the menu on screen when the selection is near a side edge.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    element.style.marginLeft = "0px";
    const { left, right } = element.getBoundingClientRect();
    const shift = Math.max(
      8 - left,
      Math.min(0, window.innerWidth - 8 - right),
    );
    element.style.marginLeft = `${shift}px`;
  }, [menu]);
  if (!menu) return null;
  const take = (act: (selection: QuickQuestionSelection) => void) => {
    pressingMenuRef.current = false;
    place(undefined);
    window.getSelection()?.removeAllRanges();
    act(menu.selection);
  };
  const { rect } = menu;
  // Show the buttons above the selection. On touch or near the top edge,
  // show them below it.
  const below = menu.touch || rect.top < 56;
  return createPortal(
    <div
      className={cn(
        "fixed z-50 flex -translate-x-1/2 gap-1 rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-raised p-1 shadow-lg",
        !below && "-translate-y-full",
      )}
      // Keep the selection while a button takes the click or tap.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={() => {
        pressingMenuRef.current = true;
      }}
      ref={menuRef}
      style={{
        left: rect.left + rect.width / 2,
        top: below
          ? Math.min(
              rect.bottom + (menu.touch ? TOUCH_GAP_PX : 8),
              window.innerHeight - 56,
            )
          : rect.top - 8,
      }}
    >
      <Button
        className="h-8 text-dashboard-text"
        onClick={() => take(onAsk)}
        variant="ghost"
      >
        Quick question
      </Button>
      {onRespond ? (
        <Button
          className="h-8 text-dashboard-text"
          onClick={() =>
            take(({ range }) =>
              onRespond(markdownQuote(selectionMarkdown(range))),
            )
          }
          variant="ghost"
        >
          Respond
        </Button>
      ) : null}
    </div>,
    document.body,
  );
}

/**
 * Ask in a Quick question. The first question starts the hidden, read-only
 * fork. A retry with the same thread key finds that fork again.
 */
function useAskQuickQuestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      forkId?: string;
      /** The composer key of this ask, so a retry cannot add the question twice. */
      idempotencyKey: string;
      messageId: string;
      quote: string;
      sourceConversationId: string;
      text: string;
      threadKey: string;
    }) => {
      const forkId =
        args.forkId ??
        (
          await post(
            forkConversationResponseSchema,
            `/api/conversations/${encodeURIComponent(args.sourceConversationId)}/forks`,
            {
              idempotencyKey: args.threadKey,
              messageId: args.messageId,
              quickQuestion: { quote: args.quote },
            },
          )
        ).conversationId;
      return post(
        acceptedConversationMessageSchema,
        `/api/conversations/${encodeURIComponent(forkId)}/messages`,
        { idempotencyKey: args.idempotencyKey, message: args.text },
      );
    },
    onSuccess: (accepted) =>
      queryClient.invalidateQueries({
        queryKey: conversationDetailQueryKey(accepted.conversationId),
      }),
  });
}

/** Keep a Quick question as a fork that lists show. */
function useKeepQuickQuestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (forkId: string) =>
      post(
        forkConversationResponseSchema,
        `/api/conversations/${encodeURIComponent(forkId)}/quick-question/keep`,
        {},
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["dashboard", "conversations"],
      }),
  });
}

/**
 * Own one Quick question thread for a Conversation page. The page keeps it,
 * so an answer that arrives while another panel shows is not lost. Closing
 * leaves the hidden fork unlisted, so the question is gone for the reader.
 */
export function useQuickQuestionThread(conversationId: string) {
  const [saved, setThread] = useState<QuickQuestionThread>();
  // The page stays mounted across Conversations. A thread belongs to one.
  const thread = saved?.conversationId === conversationId ? saved : undefined;
  const ask = useAskQuickQuestion();
  const { mutateAsync, reset } = ask;

  const open = useCallback(
    (selection: QuickQuestionSelection) => {
      reset();
      setHighlight(selection.range);
      setThread({
        ...selection,
        asked: [],
        conversationId,
        id: crypto.randomUUID(),
      });
    },
    [conversationId, reset],
  );
  const close = useCallback(() => {
    reset();
    setHighlight(undefined);
    setThread(undefined);
  }, [reset]);
  // Leaving the Conversation discards its thread.
  useEffect(
    () => () => {
      setHighlight(undefined);
      setThread(undefined);
    },
    [conversationId],
  );

  const submit = useCallback(
    async (text: string, idempotencyKey: string) => {
      if (!thread) return;
      const accepted = await mutateAsync({
        forkId: thread.forkId,
        idempotencyKey,
        messageId: thread.messageId,
        quote: thread.quote,
        sourceConversationId: conversationId,
        text,
        threadKey: thread.id,
      });
      // A closed or replaced thread drops its late result.
      setThread((current) =>
        current?.id === thread.id
          ? {
              ...current,
              asked: [...current.asked, text],
              askedAtMs: Date.now(),
              forkId: accepted.conversationId,
            }
          : current,
      );
    },
    [conversationId, mutateAsync, thread],
  );

  return {
    close,
    error: ask.error,
    open,
    pending: ask.isPending,
    submit,
    thread,
  };
}

/** Messages of the fork after the selected reply: the questions and answers. */
function forkThreadMessages(
  snapshot: ConversationDetailReport | undefined,
  replyMessageId: string,
): QuickQuestionMessage[] {
  const messages = (snapshot?.events ?? []).flatMap(({ data }) =>
    data.type === "message" &&
    (data.role === "user" || data.role === "assistant") &&
    data.text
      ? [{ id: data.messageId, role: data.role, text: data.text }]
      : [],
  );
  // The copied history ends with the selected reply. A page that does not
  // reach back to it holds only new messages.
  const reply = messages.findIndex((message) => message.id === replyMessageId);
  return messages.slice(reply + 1);
}

/** Side panel for one Quick question thread. */
export function QuickQuestionPanel(props: {
  conversationId: string;
  error: Error | null;
  onClose(): void;
  onSubmit(text: string, idempotencyKey: string): Promise<void>;
  pending: boolean;
  thread: QuickQuestionThread;
}) {
  const { thread } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const me = useDashboardCoreData().data?.me.user;
  const viewerName = me?.name?.trim() || me?.email || "You";
  const agentName = getDashboardAgentName();
  // A starter prompt has no draft to hold, so the panel shows it while the
  // ask is sent. It belongs to the thread that sent it.
  const [sending, setSending] = useState<{ text: string; threadId: string }>();
  const starter = sending?.threadId === thread.id ? sending.text : undefined;
  const fork = useQuery(
    conversationDetailQueryOptions(thread.forkId, {
      fastPollUntilMs: thread.askedAtMs && thread.askedAtMs + 10_000,
    }),
  ).data;
  const saved = forkThreadMessages(fork, thread.messageId);
  const unsaved = [
    ...thread.asked.slice(
      saved.filter((message) => message.role === "user").length,
    ),
    ...(starter ? [starter] : []),
  ].map((text) => ({ role: "user" as const, text }));
  const messages = [...saved, ...unsaved];
  // Think only once the question shows. A typed question stays in the
  // composer until the ask is accepted. A failed Turn ends without an
  // answer, and the person can then ask again.
  const thinking =
    unsaved.length > 0 ||
    (fork?.status === "active" && messages.at(-1)?.role === "user");
  const busy = props.pending || thinking;

  useEffect(() => {
    footerRef.current?.querySelector("textarea")?.focus();
  }, [thread.id]);

  // Keep the newest message in view.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [messages.length, thinking]);

  return (
    <DetailsPanel
      label="Quick question"
      sheetTitle="Quick question"
      onClose={props.onClose}
      title={
        <h2 className="m-0 font-sans text-sm font-semibold text-dashboard-text">
          Quick question
        </h2>
      }
    >
      <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]">
        {/* One shrinkable column: a long word in the quote or an answer must
            wrap, not widen the panel into a horizontal scroll. */}
        <div
          className="grid content-start grid-cols-[minmax(0,1fr)] gap-5 overflow-y-auto px-4 py-4"
          ref={scrollerRef}
        >
          <blockquote className="m-0 border-l-2 border-dashboard-accent pl-2.5 text-sm text-dashboard-text-muted">
            {/* Long selections fold, so the questions stay in view. */}
            <ClampedPreview
              className="leading-relaxed break-words whitespace-pre-wrap"
              key={thread.id}
              label="quote"
              lines={QUOTE_PREVIEW_LINES}
            >
              {/* Blank lines between paragraphs spend preview lines. */}
              {thread.quote.replace(/\n\s*\n/g, "\n")}
            </ClampedPreview>
          </blockquote>
          {messages.length === 0 && !props.pending ? (
            <div className="flex flex-wrap gap-2">
              {STARTER_PROMPTS.map((prompt) => (
                <Button
                  variant="outline"
                  className="h-7 rounded-full px-2.5 text-xs"
                  key={prompt}
                  // Each click is a new ask. The panel shows the error.
                  onClick={() => {
                    const send = { text: prompt, threadId: thread.id };
                    setSending(send);
                    // A late result must not clear a newer send.
                    void props
                      .onSubmit(prompt, crypto.randomUUID())
                      .catch(() => {})
                      .finally(() =>
                        setSending((current) =>
                          current === send ? undefined : current,
                        ),
                      );
                  }}
                >
                  {prompt}
                </Button>
              ))}
            </div>
          ) : (
            messages.map((message, index) => (
              <TranscriptMessageShell
                actor={message.role === "user" ? viewerName : agentName}
                avatarUrl={message.role === "user" ? me?.avatarUrl : undefined}
                key={index}
                role={message.role}
              >
                <span
                  className={
                    message.role === "user"
                      ? "text-sm font-semibold text-dashboard-text"
                      : "text-sm font-semibold text-dashboard-accent-text"
                  }
                >
                  {message.role === "user" ? viewerName : agentName}
                </span>
                <DisplayText chat text={message.text} />
              </TranscriptMessageShell>
            ))
          )}
          {thinking ? (
            <TranscriptMessageShell actor={agentName} role="assistant">
              <span className="text-sm font-semibold text-dashboard-accent-text">
                {agentName}
              </span>
              <ShimmerText active className="text-sm text-dashboard-text-muted">
                Thinking…
              </ShimmerText>
            </TranscriptMessageShell>
          ) : null}
        </div>
        <div className="grid gap-1.5 px-3 pt-2 pb-2" ref={footerRef}>
          <ConversationComposer
            compact
            disabled={busy}
            draftId={`quick-question:${props.conversationId}`}
            error={
              props.error
                ? (props.error instanceof DashboardApiError &&
                    props.error.apiError) ||
                  "Could not ask. Try again."
                : undefined
            }
            key={thread.id}
            label="Quick question"
            onSubmit={props.onSubmit}
            placeholder={
              messages.length ? "Ask a follow-up…" : "Ask a quick question…"
            }
            holdDraftUntilAccept
            submitLabel="Ask"
          />
          <div className="flex min-w-0 items-center justify-between gap-2 pl-1 text-xs text-dashboard-text-muted">
            <span className="min-w-0 truncate">
              Closing discards this question.
            </span>
            <KeepAsForkButton
              disabled={busy}
              forkId={thread.forkId}
              // A new thread needs a new keep request.
              key={thread.id}
            />
          </div>
        </div>
      </div>
    </DetailsPanel>
  );
}

/** Keep the hidden fork: it shows in lists and is no longer read-only. */
function KeepAsForkButton(props: { disabled: boolean; forkId?: string }) {
  const navigate = useNavigate();
  const keep = useKeepQuickQuestion();
  const forkId = props.forkId;
  return (
    <Button
      className="h-7 shrink-0 px-2 text-xs whitespace-nowrap"
      disabled={!forkId || props.disabled || keep.isPending}
      onClick={() =>
        forkId &&
        keep.mutate(forkId, {
          onSuccess: () => void navigate(conversationPath(forkId)),
        })
      }
      variant="ghost"
    >
      <GitFork aria-hidden="true" size={13} />
      {keep.isError ? "Retry keep" : "Keep as fork"}
    </Button>
  );
}
