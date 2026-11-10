import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useParams } from "react-router";
import type { WalkthroughReport } from "@sentry/junior/api/schema";

import { useWalkthroughData } from "../api";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { PageRouteLoading } from "../components/PageRouteLoading";
import { PageHeader } from "../components/layout/PageHeader";
import { PageLayout } from "../components/layout/PageLayout";
import { Button } from "../components/ui/button";
import { cn } from "../styles";
import {
  WalkthroughAskPanel,
  WalkthroughFeedbackPanel,
  type WalkthroughAsk,
} from "./WalkthroughAsidePanels";
import { WalkthroughRail } from "./WalkthroughRail";
import { WalkthroughStepView } from "./WalkthroughStepView";
import { prototypeAnswer } from "./prototypeAnswers";
import {
  hunkIndex,
  latestUpdate,
  reviewDecisions,
  slotLabels,
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
  return <WalkthroughReview report={query.data} />;
}

function WalkthroughReview(props: { report: WalkthroughReport }) {
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
  const [approved, setApproved] = useState<ReadonlySet<number>>(new Set());
  const [asks, setAsks] = useState<WalkthroughAsk[]>([]);

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
    const pending = asks.filter((ask) => !ask.answer);
    if (!pending.length) return;
    // The prototype answers from fixed text. The real one runs a read-only Turn.
    const timer = window.setTimeout(() => {
      setAsks((current) =>
        current.map((ask) =>
          ask.answer ? ask : { ...ask, answer: prototypeAnswer(ask.question) },
        ),
      );
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [asks]);

  if (!step) return null;

  const stepLabel =
    step.kind === "chapter"
      ? (slotLabels[step.chapter.slot] ?? step.chapter.slot)
      : step.item.caption;
  const ask = (question: string) =>
    setAsks((current) => [
      ...current,
      { id: current.length + 1, question, stepKey: step.key, stepLabel },
    ]);
  // Asks and banners can point into the other mode, so switch to it first.
  const openStep = (key: string) => {
    const inUpdate = walkthroughSteps(document, "update").some(
      (s) => s.key === key,
    );
    if (!steps.some((s) => s.key === key))
      setMode(inUpdate && update ? "update" : "story");
    setActiveKey(key);
  };

  return (
    <PageLayout className="max-w-screen-2xl">
      <PageHeader
        actions={
          update ? (
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
          ) : undefined
        }
        description={document.content.intent}
        documentTitle={`Walkthrough · ${document.content.title}`}
        title={document.content.title}
      />
      <div className="grid gap-8 lg:grid-cols-[16rem_minmax(0,1fr)_20rem]">
        <WalkthroughRail
          activeKey={step.key}
          answers={answers}
          approved={approved}
          decisions={decisions}
          document={document}
          hunks={hunks}
          onApprove={(pr) =>
            setApproved((current) => new Set([...current, pr]))
          }
          onSelect={setActiveKey}
          steps={steps}
        />
        <main className="grid min-w-0 content-start gap-6">
          <WalkthroughStepView
            answers={answers}
            decisions={decisions}
            document={document}
            hunks={hunks}
            onAnswer={(decisionId, value, note) =>
              setAnswers((current) => ({
                ...current,
                [decisionId]: { value, note },
              }))
            }
            onAsk={ask}
            onOpenStep={openStep}
            step={step}
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
            <span className="text-xs text-dashboard-text-faint">
              {index + 1} of {steps.length}
            </span>
            <Button
              disabled={index === steps.length - 1}
              onClick={() => setActiveKey(steps[index + 1]?.key ?? step.key)}
              type="button"
            >
              Next
              <ArrowRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </main>
        <aside className="grid content-start gap-8">
          <WalkthroughAskPanel
            activeKey={step.key}
            asks={asks}
            onAsk={ask}
            onOpen={openStep}
          />
          <WalkthroughFeedbackPanel answers={answers} decisions={decisions} />
          <p className="m-0 text-xs text-dashboard-text-faint">
            {document.meta.modelId.split("/").at(-1)}
            {document.meta.costUsd !== undefined
              ? ` · $${document.meta.costUsd.toFixed(2)}`
              : ""}
            {" · "}Brief v{document.meta.briefVersion}
          </p>
        </aside>
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
