import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { getDashboardAgentName } from "../agentName";
import { useDashboardCoreData } from "../api";
import { ShimmerText } from "../components/ShimmerText";
import { Button } from "../components/ui/button";
import { ConversationComposer } from "../conversations/ConversationComposer";
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
 * Questions beside the story: a chat with the reviewer's own hidden
 * Conversation. A version that is not ready takes no questions.
 */
export function WalkthroughQuestions(props: {
  chapter?: QuestionsChapter;
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
  return <QuestionsChat chapter={props.chapter} versionId={props.versionId} />;
}

function QuestionsChat(props: {
  chapter?: QuestionsChapter;
  versionId: string;
}) {
  const { chapter, versionId } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
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

  async function submit(
    text: string,
    idempotencyKey: string,
    about: QuestionChapter | undefined,
  ) {
    const message = chapterQuestion(about, text);
    await ask.mutateAsync({ message, idempotencyKey });
    setAsked((current) => [...current, message]);
    setAskedAtMs(Date.now());
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
            submit(text, idempotencyKey, scoped)
          }
          placeholder={messages.length ? "Ask a follow-up…" : "Ask a question…"}
          submitLabel="Ask"
        />
        <p className="m-0 pl-1 text-xs text-dashboard-text-muted">
          Only you see your questions.
        </p>
      </div>
    </div>
  );
}
