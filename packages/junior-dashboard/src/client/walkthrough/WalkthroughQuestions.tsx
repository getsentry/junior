import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { getDashboardAgentName } from "../agentName";
import { useDashboardCoreData } from "../api";
import { ShimmerText } from "../components/ShimmerText";
import { Button } from "../components/ui/button";
import {
  ConversationComposer,
  type ConversationComposerHandle,
} from "../conversations/ConversationComposer";
import { conversationDetailQueryOptions } from "../conversations/queries";
import { TranscriptMessageShell } from "../conversations/TranscriptMessageShell";
import { DisplayText } from "../display-text/DisplayText";
import { DashboardApiError } from "../http";
import {
  useAskWalkthroughQuestion,
  useWalkthroughQuestionsConversation,
} from "./walkthroughApi";
import {
  chapterQuestion,
  claimQuestions,
  quotedClaim,
  readChapterQuestion,
  type QuestionChapter,
} from "./walkthroughModel";

/** The chapter the reviewer is on, with the questions it suggests. */
export type QuestionsChapter = QuestionChapter & {
  id: string;
  /** The chapter title, short enough for the scope chip. */
  label: string;
  asks: string[];
};

type QuestionMessage = { role: "user" | "assistant"; text: string };

const noSubmit = async () => {};

function savedMessages(
  snapshot: ConversationDetailReport | undefined,
): QuestionMessage[] {
  return (snapshot?.events ?? []).flatMap(({ data }) =>
    data.type === "message" &&
    (data.role === "user" || data.role === "assistant") &&
    data.text
      ? [{ role: data.role, text: data.text }]
      : [],
  );
}

/**
 * The claims this reviewer asked about in this version. It reads the same
 * cached history as the questions chat.
 */
export function useClaimQuestions(versionId: string) {
  const conversationId =
    useWalkthroughQuestionsConversation(versionId).data ?? undefined;
  const detail = useQuery(conversationDetailQueryOptions(conversationId)).data;
  return useMemo(() => claimQuestions(savedMessages(detail)), [detail]);
}

/** A claim the reviewer chose to ask about, from its card in the story. */
export type QuestionClaim = {
  claim: string;
  /** Ask about it now, or show the question already asked. */
  mode: "ask" | "show";
};

/**
 * Questions beside the story: a chat with the reviewer's own hidden
 * Conversation. A version that is not ready takes no questions.
 */
export function WalkthroughQuestions(props: {
  chapter?: QuestionsChapter;
  claim?: QuestionClaim;
  onClearClaim?(): void;
  versionId?: string;
}) {
  if (!props.versionId) {
    return (
      <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]">
        <div className="px-4 py-4 text-sm text-dashboard-text-muted">
          You can ask once the Walkthrough is ready.
        </div>
        <div className="px-3 pt-2 pb-2">
          <ConversationComposer
            compact
            disabled
            draftId="walkthrough:questions"
            label="Question"
            onSubmit={noSubmit}
            placeholder="Ask a question…"
            submitLabel="Ask"
          />
        </div>
      </div>
    );
  }
  return (
    <QuestionsChat
      chapter={props.chapter}
      claim={props.claim}
      onClearClaim={props.onClearClaim}
      versionId={props.versionId}
    />
  );
}

function QuestionsChat(props: {
  chapter?: QuestionsChapter;
  claim?: QuestionClaim;
  onClearClaim?(): void;
  versionId: string;
}) {
  const { chapter, versionId } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ConversationComposerHandle>(null);
  const me = useDashboardCoreData().data?.me.user;
  const viewerName = me?.name?.trim() || me?.email || "You";
  const agentName = getDashboardAgentName();
  const conversationId =
    useWalkthroughQuestionsConversation(versionId).data ?? undefined;
  const ask = useAskWalkthroughQuestion(versionId);
  // Questions sent from this page, shown until the history has them.
  const [asked, setAsked] = useState<string[]>([]);
  const [askedAtMs, setAskedAtMs] = useState<number>();
  // The chapter whose scope the reviewer removed. A new chapter starts scoped.
  const [unscopedChapterId, setUnscopedChapterId] = useState<string>();
  const scoped =
    chapter && unscopedChapterId !== chapter.id ? chapter : undefined;
  // A claim to ask about belongs to the chapter, so it needs the scope.
  const askClaim =
    scoped && props.claim?.mode === "ask" ? props.claim.claim : undefined;

  const detail = useQuery(
    conversationDetailQueryOptions(conversationId, {
      fastPollUntilMs: askedAtMs && askedAtMs + 10_000,
    }),
  ).data;
  const saved = savedMessages(detail);
  const unsaved = asked
    .slice(saved.filter((message) => message.role === "user").length)
    .map((text) => ({ role: "user" as const, text }));
  const messages = [...saved, ...unsaved];
  // A failed Turn ends without an answer. The reviewer can then ask again.
  const thinking =
    ask.isPending ||
    unsaved.length > 0 ||
    (detail?.status === "active" && messages.at(-1)?.role === "user");
  const askedTexts = new Set(
    messages
      .filter((message) => message.role === "user")
      .map((message) => readChapterQuestion(message.text).text),
  );
  const suggestions = (chapter?.asks ?? []).filter(
    (text) => !askedTexts.has(text),
  );

  // Keep the newest message in view.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [messages.length, thinking]);

  // A claim card asked to ask about it: put the cursor in the composer.
  // Or it asked to show its question: bring that question into view. Each
  // click makes a new claim object, so this runs once per click.
  const claim = props.claim;
  useEffect(() => {
    if (!claim) return;
    if (claim.mode === "ask") {
      setUnscopedChapterId(undefined);
      composerRef.current?.focus();
      return;
    }
    const quoted = quotedClaim(claim.claim);
    const target = [
      ...(scrollerRef.current?.querySelectorAll<HTMLElement>("[data-claim]") ??
        []),
    ]
      .filter((node) => node.dataset.claim === quoted)
      .at(-1);
    target?.scrollIntoView({ block: "start" });
  }, [claim]);

  async function submit(
    text: string,
    idempotencyKey: string,
    about: QuestionChapter | undefined,
  ) {
    const message = chapterQuestion(about, text);
    await ask.mutateAsync({ message, idempotencyKey });
    setAsked((current) => [...current, message]);
    setAskedAtMs(Date.now());
    if (about?.claim) props.onClearClaim?.();
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]">
      {/* One shrinkable column: a long word in an answer must wrap, not
          widen the panel into a horizontal scroll. */}
      <div
        className="thin-scrollbar grid content-start grid-cols-[minmax(0,1fr)] gap-5 overflow-y-auto overscroll-contain px-4 py-4"
        ref={scrollerRef}
      >
        {messages.length === 0 && !thinking ? (
          <p className="m-0 text-sm text-dashboard-text-muted">
            Answers come from the Walkthrough and its code.
          </p>
        ) : null}
        {messages.map((message, index) => {
          const question =
            message.role === "user"
              ? readChapterQuestion(message.text)
              : undefined;
          return (
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
              {question?.chapter ? (
                <span className="text-xs text-dashboard-text-muted">
                  About {question.chapter}
                </span>
              ) : null}
              {question?.claim ? <ClaimQuote claim={question.claim} /> : null}
              <DisplayText chat text={question?.text ?? message.text} />
            </TranscriptMessageShell>
          );
        })}
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
        {chapter && suggestions.length && !thinking ? (
          <div className="flex flex-wrap gap-2">
            {suggestions.map((text) => (
              <Button
                className="h-auto min-h-7 rounded-full px-2.5 py-1 text-left text-xs whitespace-normal"
                key={text}
                // Each click is a new ask about this chapter. The composer
                // shows the error.
                onClick={() =>
                  void submit(text, crypto.randomUUID(), chapter).catch(
                    () => {},
                  )
                }
                type="button"
              >
                {text}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="grid gap-1.5 px-3 pt-2 pb-2">
        {askClaim ? (
          <div className="flex items-start gap-2 rounded-md border border-dashboard-border-subtle px-2.5 py-2">
            <div className="grid min-w-0 flex-1 gap-0.5">
              <span className="text-xs font-medium text-dashboard-text-muted">
                Asking about this claim
              </span>
              <span className="text-sm break-words text-dashboard-text">
                {askClaim}
              </span>
            </div>
            <Button
              aria-label="Stop asking about this claim"
              className="shrink-0"
              onClick={() => props.onClearClaim?.()}
              size="icon"
              type="button"
            >
              <X aria-hidden="true" size={14} />
            </Button>
          </div>
        ) : null}
        <ConversationComposer
          compact
          disabled={thinking}
          draftId={`walkthrough-questions:${versionId}`}
          error={
            ask.error
              ? (ask.error instanceof DashboardApiError &&
                  ask.error.apiError) ||
                "Could not ask. Try again."
              : undefined
          }
          footerStart={
            chapter ? (
              <Button
                aria-pressed={Boolean(scoped)}
                className="h-auto min-h-7 max-w-full min-w-0 px-2 py-1 text-left text-xs leading-snug"
                onClick={() =>
                  setUnscopedChapterId(scoped ? chapter.id : undefined)
                }
                type="button"
                variant="quiet"
              >
                <span className="min-w-0 break-words whitespace-normal">
                  {scoped
                    ? `About: ${chapter.label}`
                    : "About: the Walkthrough"}
                </span>
                {scoped ? <X aria-hidden="true" size={12} /> : null}
              </Button>
            ) : undefined
          }
          holdDraftUntilAccept
          label="Question"
          onSubmit={(text, idempotencyKey) =>
            submit(
              text,
              idempotencyKey,
              scoped && askClaim ? { ...scoped, claim: askClaim } : scoped,
            )
          }
          placeholder={
            askClaim
              ? "What do you want to know before you decide?"
              : messages.length
                ? "Ask a follow-up…"
                : "Ask a question…"
          }
          ref={composerRef}
          submitLabel="Ask"
        />
        <p className="m-0 pl-1 text-xs text-dashboard-text-muted">
          Only you see your questions.
        </p>
      </div>
    </div>
  );
}

/** The claim a question asks about, quoted above the question. */
function ClaimQuote(props: { claim: string }) {
  return (
    // The claim card finds this question by its claim.
    <blockquote
      className="m-0 scroll-mt-4 border-l-2 border-dashboard-border-emphasis pl-2 text-sm break-words text-dashboard-text-subtle"
      data-claim={props.claim}
    >
      <span className="font-medium text-dashboard-text-muted">Claim: </span>
      {props.claim}
    </blockquote>
  );
}
