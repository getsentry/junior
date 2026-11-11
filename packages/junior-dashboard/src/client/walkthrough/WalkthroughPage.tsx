import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Link, useParams } from "react-router";
import type {
  WalkthroughDocument,
  WalkthroughVersionResponse,
} from "@sentry/junior/api/schema";

import { hasPanelSpace } from "../components/DetailsPanel";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { PageRouteLoading } from "../components/PageRouteLoading";
import { ShimmerText } from "../components/ShimmerText";
import { PageHeader } from "../components/layout/PageHeader";
import { PageLayout } from "../components/layout/PageLayout";
import { Button } from "../components/ui/button";
import { useDocumentTitle } from "../documentTitle";
import { DisplayText } from "../display-text/DisplayText";
import { WalkthroughChangeSummaryView } from "./WalkthroughChanges";
import { WalkthroughAlsoChanged } from "./WalkthroughAlsoChanged";
import { WalkthroughChapterView } from "./WalkthroughChapterView";
import { WalkthroughFrame } from "./WalkthroughFrame";
import {
  useClaimQuestions,
  WalkthroughQuestions,
  type QuestionClaim,
} from "./WalkthroughQuestions";
import { WalkthroughRail } from "./WalkthroughRail";
import { WalkthroughReview } from "./WalkthroughReview";
import {
  CountBadge,
  WalkthroughQuestionsPanel,
  WalkthroughSidePanel,
  type WalkthroughSideTab,
} from "./WalkthroughSidePanel";
import {
  useSaveWalkthroughAnswer,
  useStartWalkthrough,
  useWalkthroughAnswers,
  useWalkthroughData,
} from "./walkthroughApi";
import {
  chapterTitle,
  openDecisionCount,
  reviewAnswers,
  reviewDecisions,
  versionTarget,
} from "./walkthroughModel";
import {
  addedChapterRanks,
  chapterChanges,
  changeSummary,
  lastSeenRank,
  walkthroughChapters,
} from "./walkthroughUpdates";
import type { ChapterMark } from "./WalkthroughRail";

/** Read one Walkthrough: a story with code as evidence. */
export function WalkthroughPage() {
  const params = useParams();
  const query = useWalkthroughData(params.walkthroughId);
  if (!query.data && !query.error) {
    return (
      <PageRouteLoading
        description=""
        label="Loading Walkthrough"
        title="Walkthrough"
      />
    );
  }
  if (!query.data) {
    return (
      <PageLayout>
        <PageHeader title="Walkthrough" />
        <EmptyTelemetry>This Walkthrough is unavailable.</EmptyTelemetry>
      </PageLayout>
    );
  }
  const version = query.data;
  if (version.status === "ready" && version.document) {
    return <ReadyWalkthrough document={version.document} version={version} />;
  }
  return <PendingWalkthrough version={version} />;
}

function ReadyWalkthrough(props: {
  document: WalkthroughDocument;
  version: WalkthroughVersionResponse;
}) {
  const { document, version } = props;
  const chapters = useMemo(() => walkthroughChapters(document), [document]);
  const [index, setIndex] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const chapter = chapters[index] ?? chapters[0];
  const decisions = useMemo(() => reviewDecisions(document), [document]);
  const lineageAnswers = useWalkthroughAnswers(version.id);
  // Answers carry over from earlier versions until the code they judged
  // changes. Reopened ones are shown only as context.
  const {
    current: answers,
    reopened,
    feedback,
  } = reviewAnswers(document, decisions, lineageAnswers);
  const seen = lastSeenRank(document, lineageAnswers);
  const changes = chapterChanges(document, seen);
  const added = addedChapterRanks(document);
  const summary = changeSummary(document, seen);
  const marks = new Map<string, ChapterMark>();
  for (const c of chapters) {
    if ((added.get(c.id) ?? 0) > seen) marks.set(c.id, "new");
    else if (changes.get(c.id)?.some((change) => change.unseen)) {
      marks.set(c.id, "changed");
    }
  }
  const save = useSaveWalkthroughAnswer(version.id);
  const open = openDecisionCount(decisions, answers);
  const asksHere = (at: number) => decisions.some((d) => d.chapterIndex === at);
  const [tab, setTab] = useState<WalkthroughSideTab>(() =>
    asksHere(0) ? "review" : "questions",
  );
  const [sheetOpen, setSheetOpen] = useState(false);
  const questions = useClaimQuestions(version.id);
  // The claim whose card asked to ask about it, or to show its question.
  const [claim, setClaim] = useState<QuestionClaim>();

  // Each pane scrolls on its own, so a new chapter starts at the top.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [index]);

  // A chapter that asks for decisions opens the review beside it. Other
  // chapters show questions. The reviewer can still switch tabs.
  function openChapter(next: number) {
    setIndex(next);
    setClaim(undefined);
    setTab(asksHere(next) ? "review" : "questions");
  }

  // Questions open beside the claim, so the reviewer can answer it after.
  function claimQuestion(text: string, mode: QuestionClaim["mode"]) {
    setClaim({ claim: text, mode });
    setTab("questions");
    if (!hasPanelSpace()) setSheetOpen(true);
  }

  useDocumentTitle(`Walkthrough · ${document.content.title}`);
  if (!chapter) return null;

  return (
    <WalkthroughFrame
      action={
        <Button
          onClick={() => {
            setTab("review");
            if (!hasPanelSpace()) setSheetOpen(true);
          }}
          type="button"
        >
          Review
          {open ? <CountBadge count={open} label={`${open} open`} /> : null}
        </Button>
      }
      intent={<DisplayText inline text={document.content.intent} />}
      chapterId={chapter.id}
      intro={index === 0}
      mainRef={mainRef}
      rail={
        <WalkthroughRail
          activeIndex={index}
          chapters={chapters}
          marks={marks}
          onSelect={openChapter}
        />
      }
      side={
        <WalkthroughSidePanel
          onSheetClose={() => setSheetOpen(false)}
          onTabChange={setTab}
          openCount={open}
          questions={
            <WalkthroughQuestions
              chapter={{
                id: chapter.id,
                label: chapterTitle(chapter),
                title: chapter.caption,
                asks: chapter.asks,
              }}
              claim={claim}
              onClearClaim={() => setClaim(undefined)}
              versionId={version.id}
            />
          }
          review={
            <WalkthroughReview
              activeChapter={index}
              answers={answers}
              chapterTitles={chapters.map(chapterTitle)}
              decisions={decisions}
              document={document}
              onOpenChapter={(next) => {
                openChapter(next);
                setSheetOpen(false);
              }}
            />
          }
          sheetOpen={sheetOpen}
          tab={tab}
        />
      }
      sourceConversationId={document.sourceConversationId}
      title={document.content.title}
      version={version}
    >
      <div className="grid max-w-5xl content-start gap-6 px-6 py-6 sm:px-8">
        {summary ? (
          <WalkthroughChangeSummaryView
            chapters={chapters}
            onOpenChapter={openChapter}
            summary={summary}
          />
        ) : null}
        <WalkthroughChapterView
          added={marks.get(chapter.id) === "new"}
          answers={answers}
          chapter={chapter}
          changes={changes.get(chapter.id) ?? []}
          decisions={decisions.filter((d) => d.chapterIndex === index)}
          document={document}
          feedback={feedback}
          index={index}
          key={chapter.id}
          onAnswer={(answer) => save.mutate(answer)}
          onClaimQuestion={claimQuestion}
          questions={questions}
          reopened={reopened}
          total={chapters.length}
        />
        {index === chapters.length - 1 ? (
          <WalkthroughAlsoChanged document={document} />
        ) : null}
        <div className="flex items-center justify-between border-t border-dashboard-border-subtle pt-4">
          <Button
            disabled={index === 0}
            onClick={() => openChapter(index - 1)}
            type="button"
            variant="quiet"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back
          </Button>
          <Button
            disabled={index === chapters.length - 1}
            onClick={() => openChapter(index + 1)}
            type="button"
          >
            Next
            <ArrowRight aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>
    </WalkthroughFrame>
  );
}

/** A version that is still generating, or that failed. */
function PendingWalkthrough(props: { version: WalkthroughVersionResponse }) {
  const { version } = props;
  const start = useStartWalkthrough();
  const target = versionTarget(version);
  const top = version.codeChanges.at(-1);
  const title = top?.title ?? "Walkthrough";
  useDocumentTitle(`Walkthrough · ${title}`);
  const mainRef = useRef<HTMLElement>(null);
  const failed = version.status === "failed";
  const previous = version.versions
    .filter((entry) => entry.status === "ready" && entry.id !== version.id)
    .at(-1);

  return (
    <WalkthroughFrame
      intro
      mainRef={mainRef}
      rail={<WalkthroughRail chapters={[]} />}
      side={<WalkthroughQuestionsPanel />}
      title={title}
      version={version}
    >
      <div className="grid max-w-2xl content-start gap-3 px-6 py-10 sm:px-8">
        {failed ? (
          <>
            <h2 className="m-0 font-display text-2xl leading-tight font-medium text-dashboard-text">
              This Walkthrough could not be made
            </h2>
            {version.failureReason ? (
              <p className="m-0 text-base leading-7 text-dashboard-text-subtle">
                {version.failureReason}
              </p>
            ) : null}
            {target ? (
              <Button
                className="w-fit"
                disabled={start.isPending}
                onClick={() => start.mutate(target)}
                type="button"
              >
                Try again
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <ShimmerText
              active
              as="strong"
              className="font-display text-2xl leading-tight font-medium text-dashboard-text"
            >
              {previous
                ? "Updating the Walkthrough…"
                : "Writing the Walkthrough…"}
            </ShimmerText>
            <p className="m-0 text-base leading-7 text-dashboard-text-subtle">
              This takes a few minutes. You can leave this page and come back.
            </p>
            {previous ? (
              <Link
                className="w-fit text-sm text-dashboard-text underline underline-offset-4"
                to={`/walkthroughs/${encodeURIComponent(previous.id)}`}
              >
                Read the previous version
              </Link>
            ) : null}
          </>
        )}
      </div>
    </WalkthroughFrame>
  );
}
