import { GitFork } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";

import { getDashboardAgentName } from "../agentName";
import { useDashboardCoreData } from "../api";
import { DetailsPanel } from "../components/DetailsPanel";
import { ShimmerText } from "../components/ShimmerText";
import { Button } from "../components/ui/button";
import { DisplayText } from "../display-text/DisplayText";
import { DashboardApiError } from "../http";
import { cn } from "../styles";
import { ConversationComposer } from "./ConversationComposer";
import { conversationPath } from "./conversationRoutes";
import { useForkConversation, useQuickQuestion } from "./queries";
import { TranscriptMessageShell } from "./TranscriptMessageShell";

const HIGHLIGHT_NAME = "quick-question";
const STARTER_PROMPTS = ["Explain this", "Is this right?", "What's the risk?"];

type QuickQuestionMessage = { role: "user" | "assistant"; text: string };

/** The selected text in one Junior reply. */
type QuickQuestionSelection = {
  messageId: string;
  quote: string;
  range: Range;
};

type QuickQuestionThread = QuickQuestionSelection & {
  conversationId: string;
  id: string;
  messages: QuickQuestionMessage[];
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
  if (!quote) return undefined;
  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const element = node instanceof Element ? node : node.parentElement;
  const message = element?.closest<HTMLElement>(
    "[data-quick-question-message-id]",
  );
  const messageId = message?.dataset.quickQuestionMessageId;
  if (!message || !messageId || !root.contains(message)) return undefined;
  return { messageId, quote, range: range.cloneRange() };
}

/**
 * Show a "Quick question" button above a text selection in a Junior reply.
 * It hides on scroll, because its position would go stale.
 */
export function QuickQuestionSelectionButton(props: {
  rootRef: RefObject<HTMLElement | null>;
  onAsk(selection: QuickQuestionSelection): void;
}) {
  const { rootRef, onAsk } = props;
  const [anchor, setAnchor] = useState<DOMRect>();
  useEffect(() => {
    const update = () =>
      setAnchor(readSelection(rootRef.current)?.range.getBoundingClientRect());
    const clearIfEmpty = () => {
      if (!readSelection(rootRef.current)) setAnchor(undefined);
    };
    const hide = () => setAnchor(undefined);
    document.addEventListener("mouseup", update);
    document.addEventListener("keyup", update);
    document.addEventListener("selectionchange", clearIfEmpty);
    document.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("mouseup", update);
      document.removeEventListener("keyup", update);
      document.removeEventListener("selectionchange", clearIfEmpty);
      document.removeEventListener("scroll", hide, true);
    };
  }, [rootRef]);
  if (!anchor) return null;
  // Show the button above the selection, or below it near the top edge.
  const above = anchor.top >= 56;
  return createPortal(
    <div
      className={cn(
        "fixed z-50 -translate-x-1/2 rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-raised p-1 shadow-lg",
        above && "-translate-y-full",
      )}
      style={{
        left: anchor.left + anchor.width / 2,
        top: above
          ? anchor.top - 8
          : Math.min(anchor.bottom + 8, window.innerHeight - 56),
      }}
    >
      <Button
        className="h-8 text-dashboard-text"
        // Keep the selection while the button takes the click.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const selection = readSelection(rootRef.current);
          setAnchor(undefined);
          if (!selection) return;
          window.getSelection()?.removeAllRanges();
          onAsk(selection);
        }}
        variant="quiet"
      >
        Quick question
      </Button>
    </div>,
    document.body,
  );
}

/**
 * Own one Quick question thread for a Conversation page. The page keeps it,
 * so an answer that arrives while another panel shows is not lost. Only the
 * browser holds the thread: closing or reloading discards it.
 */
export function useQuickQuestionThread(conversationId: string) {
  const [saved, setThread] = useState<QuickQuestionThread>();
  // The page stays mounted across Conversations. A thread belongs to one.
  const thread = saved?.conversationId === conversationId ? saved : undefined;
  const ask = useQuickQuestion(conversationId);
  const { mutateAsync, reset } = ask;

  const open = useCallback(
    (selection: QuickQuestionSelection) => {
      reset();
      setHighlight(selection.range);
      setThread({
        ...selection,
        conversationId,
        id: crypto.randomUUID(),
        messages: [],
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
    async (text: string) => {
      if (!thread) return;
      const messages: QuickQuestionMessage[] = [
        ...thread.messages,
        { role: "user", text },
      ];
      setThread({ ...thread, messages });
      try {
        const answer = await mutateAsync({
          messageId: thread.messageId,
          quote: thread.quote,
          messages,
        });
        // A closed or replaced thread drops its late answer.
        setThread((current) =>
          current?.id === thread.id
            ? {
                ...current,
                messages: [
                  ...messages,
                  { role: "assistant", text: answer.text },
                ],
              }
            : current,
        );
      } catch (error) {
        // The composer puts the question back in the draft.
        setThread((current) =>
          current?.id === thread.id
            ? { ...current, messages: thread.messages }
            : current,
        );
        throw error;
      }
    },
    [mutateAsync, thread],
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

/** Side panel for one Quick question thread. */
export function QuickQuestionPanel(props: {
  conversationId: string;
  error: Error | null;
  onClose(): void;
  onSubmit(text: string): Promise<void>;
  pending: boolean;
  thread: QuickQuestionThread;
}) {
  const { thread } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const me = useDashboardCoreData().data?.me.user;
  const viewerName = me?.name?.trim() || me?.email || "You";
  const agentName = getDashboardAgentName();

  useEffect(() => {
    footerRef.current?.querySelector("textarea")?.focus();
  }, [thread.id]);

  // Keep the newest message in view.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [thread.messages.length, props.pending]);

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
        <div
          className="grid content-start gap-5 overflow-y-auto px-5 py-4"
          ref={scrollerRef}
        >
          <blockquote className="m-0 border-l-2 border-dashboard-accent pl-3 text-sm whitespace-pre-wrap text-dashboard-text">
            {thread.quote}
          </blockquote>
          {thread.messages.length === 0 ? (
            <div className="flex flex-wrap gap-2">
              {STARTER_PROMPTS.map((prompt) => (
                <Button
                  className="h-8 rounded-full"
                  disabled={props.pending}
                  key={prompt}
                  // The panel shows the error.
                  onClick={() => void props.onSubmit(prompt).catch(() => {})}
                >
                  {prompt}
                </Button>
              ))}
            </div>
          ) : (
            thread.messages.map((message, index) => (
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
          {props.pending ? (
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
        <div
          className="grid gap-1 border-t border-dashboard-border px-3 pt-3 pb-2"
          ref={footerRef}
        >
          <ConversationComposer
            compact
            disabled={props.pending}
            draftId={`quick-question:${props.conversationId}`}
            error={
              props.error
                ? (props.error instanceof DashboardApiError &&
                    props.error.apiError) ||
                  "Could not answer. Try again."
                : undefined
            }
            key={thread.id}
            label="Quick question"
            onSubmit={(text) => props.onSubmit(text)}
            placeholder={
              thread.messages.length
                ? "Ask a follow-up…"
                : "Ask a quick question…"
            }
            restoreDraftOnError
            submitLabel="Ask"
          />
          <div className="flex items-center justify-between gap-2 px-1 text-xs text-dashboard-text-muted">
            <span>Closing discards this question.</span>
            <KeepAsForkButton
              conversationId={props.conversationId}
              disabled={props.pending}
              // A new thread needs a new fork request and idempotency key.
              key={thread.id}
              thread={thread}
            />
          </div>
        </div>
      </div>
    </DetailsPanel>
  );
}

/**
 * Promote the thread to a fork after the selected reply. The fork's first
 * message carries the selection and the thread, and starts a full Turn.
 */
function KeepAsForkButton(props: {
  conversationId: string;
  disabled: boolean;
  thread: QuickQuestionThread;
}) {
  const navigate = useNavigate();
  const fork = useForkConversation(props.conversationId);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  return (
    <Button
      className="h-7 px-2 text-xs"
      disabled={props.disabled || fork.isPending}
      onClick={() =>
        fork.mutate(
          {
            idempotencyKey,
            message: forkMessage(props.thread),
            messageId: props.thread.messageId,
          },
          {
            onSuccess: (accepted) =>
              navigate(conversationPath(accepted.conversationId)),
          },
        )
      }
      variant="quiet"
    >
      <GitFork aria-hidden="true" size={13} />
      {fork.isError ? "Retry fork" : "Keep as fork"}
    </Button>
  );
}

function forkMessage(thread: QuickQuestionThread): string {
  const quote = thread.quote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const turns = thread.messages.map((message) =>
    message.role === "user"
      ? `Quick question: ${message.text}`
      : `Your answer: ${message.text}`,
  );
  return [`About this part of your reply:\n\n${quote}`, ...turns].join("\n\n");
}
