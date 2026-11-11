import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronDown } from "lucide-react";
import type { WalkthroughVersionResponse } from "@sentry/junior/api/schema";

import { cn } from "../styles";
import { WalkthroughVersions } from "./WalkthroughChanges";
import { WalkthroughMeta, WalkthroughSource } from "./WalkthroughMeta";

/**
 * Three panes, each with its own scroll: the rail, the story, and questions.
 * The page itself does not scroll.
 *
 * The full header (title, intent, and the metadata row) opens the story: it
 * sits at the top of the first chapter and scrolls away with it. Elsewhere,
 * and once it scrolls away, one bar keeps the title, the PRs, the cost, and
 * the actions. Its title opens the intent again.
 */
export function WalkthroughFrame(props: {
  action?: ReactNode;
  /** The open chapter. Opening another one folds the intent again. */
  chapterId?: string;
  children: ReactNode;
  intent?: ReactNode;
  /** Show the full header at the top of the story. */
  intro: boolean;
  mainRef: RefObject<HTMLElement | null>;
  rail: ReactNode;
  side: ReactNode;
  /** The Conversation that made the PRs, when the viewer may read it. */
  sourceConversationId?: string;
  title: string;
  version: WalkthroughVersionResponse;
}) {
  const introRef = useRef<HTMLDivElement>(null);
  const [introInView, setIntroInView] = useState(true);
  const [expandedIn, setExpandedIn] = useState<string>();
  const expanded = expandedIn !== undefined && expandedIn === props.chapterId;

  useEffect(() => {
    const root = props.mainRef.current;
    const intro = introRef.current;
    if (!props.intro || !root || !intro) return;
    if (typeof IntersectionObserver === "undefined") return;
    // The bar comes back once half the header has scrolled away, so a short
    // chapter still reaches it. Showing the bar does not move the header
    // inside the story, so this cannot flip back and forth.
    const observer = new IntersectionObserver(
      ([entry]) => setIntroInView((entry?.intersectionRatio ?? 0) >= 0.5),
      { root, threshold: 0.5 },
    );
    observer.observe(intro);
    return () => observer.disconnect();
  }, [props.intro, props.mainRef]);

  const actions = (
    <div className="flex shrink-0 items-center gap-2">
      <WalkthroughVersions version={props.version} />
      {props.action}
    </div>
  );
  const showBar = !props.intro || !introInView;
  // One page title: the full header owns it while it is in the story.
  const Heading = props.intro ? "p" : "h1";

  return (
    <div className="grid h-full min-h-0 w-full overflow-hidden bg-dashboard-bg lg:grid-cols-[18rem_minmax(0,1fr)]">
      {props.rail}
      <div className="flex min-h-0 min-w-0 flex-col">
        {showBar ? (
          <header className="border-b border-dashboard-border">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 px-6 py-2.5 sm:px-8">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <Heading className="m-0 min-w-0 font-display text-base leading-snug font-semibold text-dashboard-text">
                  {props.intent ? (
                    <button
                      aria-expanded={expanded}
                      className="inline-flex cursor-pointer items-start gap-1 rounded-sm border-0 bg-transparent p-0 text-left font-display text-base leading-snug font-semibold text-dashboard-text hover:text-dashboard-text-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
                      onClick={() =>
                        setExpandedIn(expanded ? undefined : props.chapterId)
                      }
                      type="button"
                    >
                      <span className="min-w-0 break-words">{props.title}</span>
                      <ChevronDown
                        aria-hidden="true"
                        className={cn(
                          "mt-1 size-4 shrink-0 text-dashboard-text-muted transition-transform",
                          expanded && "rotate-180",
                        )}
                      />
                    </button>
                  ) : (
                    <span className="break-words">{props.title}</span>
                  )}
                </Heading>
                <WalkthroughMeta version={props.version} />
              </div>
              {actions}
            </div>
            {expanded && props.intent ? (
              <div className="grid max-w-3xl gap-1 px-6 pb-3 text-sm leading-relaxed text-dashboard-text-muted sm:px-8">
                <p className="m-0">{props.intent}</p>
                {props.sourceConversationId ? (
                  <p className="m-0">
                    <WalkthroughSource
                      conversationId={props.sourceConversationId}
                    />
                  </p>
                ) : null}
              </div>
            ) : null}
          </header>
        ) : null}
        {/* The side panel starts at the header rule, so its border meets it. */}
        <div className="grid min-h-0 min-w-0 flex-1 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <main
            className="thin-scrollbar min-h-0 overflow-y-auto overscroll-contain"
            ref={props.mainRef}
          >
            {props.intro ? (
              // The actions stay beside the text, which wraps.
              <div
                className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 border-b border-dashboard-border-subtle px-6 py-5 sm:px-8"
                ref={introRef}
              >
                <div className="grid min-w-0 max-w-3xl gap-1.5">
                  <h1 className="m-0 font-display text-xl leading-snug font-semibold break-words text-dashboard-text">
                    {props.title}
                  </h1>
                  {props.intent ? (
                    <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
                      {props.intent}
                    </p>
                  ) : null}
                  <WalkthroughMeta
                    sourceConversationId={props.sourceConversationId}
                    version={props.version}
                  />
                </div>
                {actions}
              </div>
            ) : null}
            {props.children}
          </main>
          {props.side}
        </div>
      </div>
    </div>
  );
}
