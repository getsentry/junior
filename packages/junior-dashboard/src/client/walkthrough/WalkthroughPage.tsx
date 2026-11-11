import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useParams } from "react-router";
import type {
  WalkthroughDocument,
  WalkthroughVersionResponse,
} from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { PageRouteLoading } from "../components/PageRouteLoading";
import { ShimmerText } from "../components/ShimmerText";
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
import { WalkthroughChapterView } from "./WalkthroughChapterView";
import { WalkthroughQuestions } from "./WalkthroughQuestions";
import { WalkthroughRail } from "./WalkthroughRail";
import { useStartWalkthrough, useWalkthroughData } from "./walkthroughApi";
import { versionTarget } from "./walkthroughModel";

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
  const { document } = props;
  const chapters = document.content.chapters;
  const [index, setIndex] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const chapter = chapters[index] ?? chapters[0];

  // Each pane scrolls on its own, so a new chapter starts at the top.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [index]);

  useDocumentTitle(`Walkthrough · ${document.content.title}`);
  if (!chapter) return null;

  return (
    <WalkthroughFrame
      intent={<DisplayText inline text={document.content.intent} />}
      mainRef={mainRef}
      rail={
        <WalkthroughRail
          activeIndex={index}
          chapters={chapters}
          onSelect={setIndex}
          sourceConversationId={document.sourceConversationId}
          version={props.version}
        />
      }
      title={document.content.title}
      version={props.version}
    >
      <div className="grid max-w-5xl content-start gap-6 px-6 py-6 sm:px-8">
        <WalkthroughChapterView
          chapter={chapter}
          document={document}
          index={index}
          total={chapters.length}
        />
        <div className="flex items-center justify-between border-t border-dashboard-border-subtle pt-4">
          <Button
            disabled={index === 0}
            onClick={() => setIndex(index - 1)}
            type="button"
            variant="quiet"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back
          </Button>
          <Button
            disabled={index === chapters.length - 1}
            onClick={() => setIndex(index + 1)}
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
  const failed = version.status === "failed";

  return (
    <WalkthroughFrame
      rail={<WalkthroughRail chapters={[]} version={version} />}
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
              Writing the Walkthrough…
            </ShimmerText>
            <p className="m-0 text-base leading-7 text-dashboard-text-subtle">
              This takes a few minutes. You can leave this page and come back.
            </p>
          </>
        )}
      </div>
    </WalkthroughFrame>
  );
}

/**
 * Three panes, each with its own scroll: the rail, the story, and questions.
 * The page itself does not scroll.
 */
function WalkthroughFrame(props: {
  children: ReactNode;
  intent?: ReactNode;
  mainRef?: Ref<HTMLElement>;
  rail: ReactNode;
  title: string;
  version: WalkthroughVersionResponse;
}) {
  const cost = props.version.costUsd;
  return (
    <div className="grid h-full min-h-0 w-full overflow-hidden bg-dashboard-bg lg:grid-cols-[18rem_minmax(0,1fr)]">
      {props.rail}
      <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
        <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-dashboard-border px-6 py-4 sm:px-8">
          <div className="grid min-w-0 max-w-3xl gap-1">
            <h1 className="m-0 font-display text-xl leading-snug font-semibold text-dashboard-text">
              {props.title}
            </h1>
            {props.intent ? (
              <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
                {props.intent}
              </p>
            ) : null}
          </div>
          {cost !== undefined ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex h-9 shrink-0 items-center rounded-md border border-dashboard-border-emphasis px-3 text-sm font-medium tabular-nums text-dashboard-text-muted">
                    ${cost.toFixed(2)}
                  </span>
                }
              />
              <TooltipContent>
                {props.version.status === "generating"
                  ? "What this Walkthrough has cost so far"
                  : "What it cost to make this Walkthrough"}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </header>
        {/* The side panel starts at the header rule, so its border meets it. */}
        <div className="grid min-h-0 min-w-0 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <main
            className="thin-scrollbar min-h-0 overflow-y-auto overscroll-contain"
            ref={props.mainRef}
          >
            {props.children}
          </main>
          <WalkthroughQuestions />
        </div>
      </div>
    </div>
  );
}
