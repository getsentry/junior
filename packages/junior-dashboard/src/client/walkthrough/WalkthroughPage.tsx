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
  // Closed at first, so the story gets the width for code beside prose.
  const [side, setSide] = useState<"questions" | "review">();
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
  const open = document.layers.reduce((sum, layer) => {
    const status = layerStatus(layer.pr, decisions, answers);
    return sum + (status.kind === "open" ? status.count : 0);
  }, 0);

  return (
    <PageLayout className="max-w-screen-2xl">
      <PageHeader
        actions={
          <div className="flex items-center gap-2">
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
              <Button onClick={() => setSide("review")} type="button">
                Your review
                {open ? (
                  <span className="text-dashboard-text-muted tabular-nums">
                    {open} to answer
                  </span>
                ) : null}
              </Button>
            ) : null}
          </div>
        }
        description={<DisplayText inline text={document.content.intent} />}
        documentTitle={`Walkthrough · ${document.content.title}`}
        title={document.content.title}
      />
      <div
        className={cn(
          "grid gap-8 lg:grid-cols-[16rem_minmax(0,1fr)]",
          side && "xl:grid-cols-[16rem_minmax(0,1fr)_24rem]",
        )}
      >
        <WalkthroughRail
          activeKey={step.key}
          document={document}
          onSelect={setActiveKey}
          steps={steps}
        />
        <main className="grid min-w-0 content-start gap-6" ref={mainRef}>
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
            onAsk={() => setSide("questions")}
            onOpenStep={openStep}
            step={step}
            total={steps.length}
          />
          <div className="flex items-center justify-between border-t border-dashboard-border-subtle pt-4">
            <Button
              disabled={index === 0}
              onClick={() => setActiveKey(steps[index - 1]?.key ?? step.key)}
              type="button"
              variant="quiet"
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
              Back
            </Button>
            <Button
              disabled={index === steps.length - 1}
              onClick={() => setActiveKey(steps[index + 1]?.key ?? step.key)}
              type="button"
            >
              Next
              <ArrowRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
          <p className="m-0 text-xs text-dashboard-text-faint">
            {document.meta.modelId.split("/").at(-1)}
            {document.meta.costUsd !== undefined
              ? ` · $${document.meta.costUsd.toFixed(2)}`
              : ""}
            {" · "}Brief v{document.meta.briefVersion}
          </p>
          <QuickQuestionSelectionButton
            onAsk={(selection) => {
              setQuote({ quote: selection.quote, stepKey: step.key });
              setSide("questions");
            }}
            rootRef={mainRef}
          />
        </main>
        {side ? (
          <div className="grid min-h-0 xl:sticky xl:top-4 xl:h-[min(calc(100dvh-2rem),46rem)]">
            {side === "questions" ? (
              <WalkthroughQuestions
                anchor={anchor}
                onClose={() => setSide("review")}
                onOpenStep={openStep}
                onSubmit={ask}
                questions={questions}
                suggestions={step.kind === "chapter" ? step.chapter.asks : []}
                walkthroughId={document.versionId}
              />
            ) : (
              <WalkthroughReview
                answers={answers}
                decisions={decisions}
                document={document}
                onClose={() => setSide(undefined)}
                onOpenStep={openStep}
              />
            )}
          </div>
        ) : null}
      </div>
    </PageLayout>
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
