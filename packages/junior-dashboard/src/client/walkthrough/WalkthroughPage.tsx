import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useParams } from "react-router";
import type { WalkthroughReport } from "@sentry/junior/api/schema";

import { useWalkthroughData } from "../api";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { PageRouteLoading } from "../components/PageRouteLoading";
import { PageHeader } from "../components/layout/PageHeader";
import { PageLayout } from "../components/layout/PageLayout";
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
  const [asking, setAsking] = useState(false);
  const [reviewPinned, setReviewPinned] = useState(false);
  // Closing the review on a step with decisions keeps it closed there.
  const [reviewClosedOn, setReviewClosedOn] = useState<string>();
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
  // The review shows on its own where the step has decisions to answer.
  // Elsewhere it stays closed, so the story gets the width.
  const stepHasDecisions = decisions.some((d) => d.stepKey === step.key);
  const side = asking
    ? "questions"
    : reviewPinned || (stepHasDecisions && reviewClosedOn !== step.key)
      ? "review"
      : undefined;
  const closeReview = () => {
    setReviewPinned(false);
    setReviewClosedOn(step.key);
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
                    <span className="inline-flex items-center rounded-md border border-dashboard-border-subtle px-2 py-1 text-xs tabular-nums text-dashboard-text-subtle">
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
            {side !== "review" ? (
              <Button
                aria-label={open ? `Your review, ${open} open` : "Your review"}
                onClick={() => {
                  setAsking(false);
                  setReviewPinned(true);
                }}
                type="button"
              >
                Your review
                {open ? (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-dashboard-accent px-1 text-2xs font-semibold leading-none tabular-nums text-dashboard-text-inverse">
                    {open}
                  </span>
                ) : null}
              </Button>
            ) : null}
          </div>
        </header>
        {/* The side panel starts at the header rule, so its border meets it. */}
        <div
          className={cn(
            "grid min-h-0 min-w-0",
            side && "xl:grid-cols-[minmax(0,1fr)_24rem]",
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
                onAsk={() => setAsking(true)}
                onOpenStep={openStep}
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
                setAsking(true);
              }}
              rootRef={mainRef}
            />
          </main>
          {side === "questions" ? (
            <WalkthroughQuestions
              anchor={anchor}
              onClose={() => setAsking(false)}
              onOpenStep={openStep}
              onSubmit={ask}
              questions={questions}
              suggestions={step.kind === "chapter" ? step.chapter.asks : []}
              walkthroughId={document.versionId}
            />
          ) : side === "review" ? (
            <WalkthroughReview
              answers={answers}
              decisions={decisions}
              document={document}
              onClose={closeReview}
              onOpenStep={openStep}
              stepTitles={stepTitles}
            />
          ) : null}
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
