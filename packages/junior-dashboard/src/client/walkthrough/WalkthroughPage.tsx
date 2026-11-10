import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useParams } from "react-router";
import type { WalkthroughReport } from "@sentry/junior/api/schema";

import { useWalkthroughData } from "../api";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { PageRouteLoading } from "../components/PageRouteLoading";
import { PageHeader } from "../components/layout/PageHeader";
import { PageLayout } from "../components/layout/PageLayout";
import { useDetailsPanel } from "../components/DetailsPanel";
import { Button } from "../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { useDocumentTitle } from "../documentTitle";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import { QuickQuestionSelectionButton } from "../conversations/QuickQuestion";
import {
  WalkthroughQuestions,
  type WalkthroughQuestion,
} from "./WalkthroughQuestions";
import { WalkthroughRail } from "./WalkthroughRail";
import { WalkthroughReview } from "./WalkthroughReview";
import {
  CountBadge,
  WalkthroughSidePanel,
  type WalkthroughSideTab,
} from "./WalkthroughSidePanel";
import { WalkthroughStepView } from "./WalkthroughStepView";
import { prototypeAnswer } from "./prototypeAnswers";
import {
  hunkIndex,
  latestUpdate,
  layerStatus,
  reviewDecisions,
  stepTitle,
  walkthroughSteps,
  type AnswerMap,
} from "./walkthroughModel";

/** Review one Walkthrough: a story with code as evidence. */
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
  return <WalkthroughView report={query.data} />;
}

function WalkthroughView(props: { report: WalkthroughReport }) {
  const { document } = props.report;
  const update = latestUpdate(document);
  const hasUnseenUpdate = Boolean(
    update && props.report.seenVersionId !== document.versionId,
  );
  const [mode, setMode] = useState<"story" | "update">(
    hasUnseenUpdate ? "update" : "story",
  );
  const steps = useMemo(
    () => walkthroughSteps(document, mode),
    [document, mode],
  );
  const hunks = useMemo(() => hunkIndex(document), [document]);
  // Decisions can sit in either mode, so name steps from both.
  const stepTitles = useMemo(
    () =>
      Object.fromEntries(
        [
          ...walkthroughSteps(document, "story"),
          ...walkthroughSteps(document, "update"),
        ].map((s) => [s.key, stepTitle(document, s)]),
      ),
    [document],
  );
  const decisions = useMemo(() => reviewDecisions(document), [document]);
  const [activeKey, setActiveKey] = useState(steps[0]?.key ?? "");
  const [answers, setAnswers] = useState<AnswerMap>(() =>
    Object.fromEntries(
      props.report.answers.map((a) => [
        a.decisionId,
        { value: a.value, note: a.note },
      ]),
    ),
  );
  const [tab, setTab] = useState<WalkthroughSideTab>("questions");
  const [sheetOpen, setSheetOpen] = useState(false);
  const panel = useDetailsPanel();
  const [questions, setQuestions] = useState<WalkthroughQuestion[]>([]);
  const [quote, setQuote] = useState<{ quote: string; stepKey: string }>();
  const mainRef = useRef<HTMLElement>(null);

  const index = Math.max(
    0,
    steps.findIndex((s) => s.key === activeKey),
  );
  const step = steps[index];

  useEffect(() => {
    if (!steps.some((s) => s.key === activeKey) && steps[0])
      setActiveKey(steps[0].key);
  }, [steps, activeKey]);

  // Each pane scrolls on its own, so a new step starts at the top of the story.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [activeKey]);

  // A step with decisions shows the review. Other steps show questions.
  useEffect(() => {
    setTab(
      decisions.some((d) => d.stepKey === activeKey) ? "review" : "questions",
    );
  }, [activeKey, decisions]);

  useDocumentTitle(`Walkthrough · ${document.content.title}`);

  useEffect(() => {
    if (!questions.some((q) => q.answer === undefined)) return;
    // The prototype answers from fixed text. The real one runs a read-only Turn.
    const timer = window.setTimeout(() => {
      setQuestions((current) =>
        current.map((q) =>
          q.answer === undefined
            ? { ...q, answer: prototypeAnswer(q.text) }
            : q,
        ),
      );
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [questions]);

  if (!step) return null;

  const title = stepTitle(document, step);
  const anchor =
    quote?.stepKey === step.key
      ? { quote: quote.quote, stepKey: step.key, stepTitle: title }
      : { stepKey: step.key, stepTitle: title };
  const ask = async (text: string) => {
    setQuestions((current) => [
      ...current,
      { ...anchor, id: crypto.randomUUID(), text },
    ]);
    setQuote(undefined);
  };
  // Links can point into the other mode, so switch to it first.
  const openStep = (key: string) => {
    const inUpdate = walkthroughSteps(document, "update").some(
      (s) => s.key === key,
    );
    if (!steps.some((s) => s.key === key))
      setMode(inUpdate && update ? "update" : "story");
    setActiveKey(key);
  };
  const showSide = (next: WalkthroughSideTab) => {
    setTab(next);
    setSheetOpen(true);
  };
  const open = document.layers.reduce((sum, layer) => {
    const status = layerStatus(layer.pr, decisions, answers);
    return sum + (status.kind === "open" ? status.count : 0);
  }, 0);

  const cost = document.meta.costUsd;

  return (
    <div className="grid h-full min-h-0 w-full overflow-hidden bg-dashboard-bg lg:grid-cols-[18rem_minmax(0,1fr)]">
      <WalkthroughRail
        activeKey={step.key}
        document={document}
        onSelect={setActiveKey}
        source={props.report.source}
        steps={steps}
      />
      <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
        <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-dashboard-border px-6 py-4 sm:px-8">
          <div className="grid min-w-0 max-w-3xl gap-1">
            <h1 className="m-0 font-display text-xl leading-snug font-semibold text-dashboard-text">
              {document.content.title}
            </h1>
            <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
              <DisplayText inline text={document.content.intent} />
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {cost !== undefined ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="text-sm tabular-nums text-dashboard-text-muted">
                      ${cost.toFixed(2)}
                    </span>
                  }
                />
                <TooltipContent>
                  What it cost to make this Walkthrough
                </TooltipContent>
              </Tooltip>
            ) : null}
            {update ? (
              <div className="flex items-center gap-1 rounded-md border border-dashboard-border-subtle p-0.5">
                <ModeButton
                  active={mode === "update"}
                  onClick={() => setMode("update")}
                >
                  Update {document.updates.length} · {update.pushes} pushes
                </ModeButton>
                <ModeButton
                  active={mode === "story"}
                  onClick={() => setMode("story")}
                >
                  Full story
                </ModeButton>
              </div>
            ) : null}
            {/* Wide screens show the review tab beside the story. */}
            {panel ? null : (
              <Button onClick={() => showSide("review")} type="button">
                Your review
                {open ? (
                  <CountBadge count={open} label={`${open} not answered`} />
                ) : null}
              </Button>
            )}
          </div>
        </header>
        {/* The side panel starts at the header rule, so its border meets it. */}
        <div
          className={cn(
            "grid min-h-0 min-w-0",
            "xl:grid-cols-[minmax(0,1fr)_24rem]",
          )}
        >
          <main
            className="thin-scrollbar min-h-0 overflow-y-auto overscroll-contain"
            ref={mainRef}
          >
            <div className="grid max-w-5xl content-start gap-6 px-6 py-6 sm:px-8">
              <WalkthroughStepView
                answers={answers}
                decisions={decisions}
                document={document}
                hunks={hunks}
                index={index}
                onAnswer={(decisionId, value, note) =>
                  setAnswers((current) => ({
                    ...current,
                    [decisionId]: { value, note },
                  }))
                }
                onAsk={() => showSide("questions")}
                onOpenStep={openStep}
                sourceConversationId={props.report.source?.conversationId}
                step={step}
                total={steps.length}
              />
              <div className="flex items-center justify-between border-t border-dashboard-border-subtle pt-4">
                <Button
                  disabled={index === 0}
                  onClick={() =>
                    setActiveKey(steps[index - 1]?.key ?? step.key)
                  }
                  type="button"
                  variant="quiet"
                >
                  <ArrowLeft aria-hidden="true" className="size-4" />
                  Back
                </Button>
                <Button
                  disabled={index === steps.length - 1}
                  onClick={() =>
                    setActiveKey(steps[index + 1]?.key ?? step.key)
                  }
                  type="button"
                >
                  Next
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Button>
              </div>
            </div>
            <QuickQuestionSelectionButton
              onAsk={(selection) => {
                setQuote({ quote: selection.quote, stepKey: step.key });
                showSide("questions");
              }}
              rootRef={mainRef}
            />
          </main>
          <WalkthroughSidePanel
            onSheetClose={() => setSheetOpen(false)}
            onTabChange={setTab}
            openCount={open}
            questions={
              <WalkthroughQuestions
                anchor={anchor}
                onOpenStep={openStep}
                onSubmit={ask}
                questions={questions}
                suggestions={step.kind === "chapter" ? step.chapter.asks : []}
                walkthroughId={document.versionId}
              />
            }
            review={
              <WalkthroughReview
                answers={answers}
                decisions={decisions}
                document={document}
                onOpenStep={openStep}
                stepTitles={stepTitles}
              />
            }
            sheetOpen={sheetOpen}
            tab={tab}
          />
        </div>
      </div>
    </div>
  );
}

function ModeButton(props: {
  active: boolean;
  children: ReactNode;
  onClick(): void;
}) {
  return (
    <button
      aria-pressed={props.active}
      className={cn(
        "cursor-pointer rounded border-0 px-2.5 py-1 text-xs",
        props.active
          ? "bg-dashboard-fill-strong text-dashboard-text"
          : "bg-transparent text-dashboard-text-muted hover:text-dashboard-text",
      )}
      onClick={props.onClick}
      type="button"
    >
      {props.children}
    </button>
  );
}
