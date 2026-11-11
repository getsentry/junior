import type { ReactNode, RefObject } from "react";
import type { WalkthroughVersionResponse } from "@sentry/junior/api/schema";

import { WalkthroughVersions } from "./WalkthroughChanges";
import { WalkthroughMeta } from "./WalkthroughMeta";

/**
 * Three panes, each with its own scroll: the rail, the story, and questions.
 * The page itself does not scroll.
 *
 * One bar, the same on every chapter, keeps the title, the PRs, the cost,
 * and the actions in reach. The intent is story content, so the first
 * chapter opens with it.
 */
export function WalkthroughFrame(props: {
  action?: ReactNode;
  children: ReactNode;
  mainRef: RefObject<HTMLElement | null>;
  rail: ReactNode;
  side: ReactNode;
  title: string;
  version: WalkthroughVersionResponse;
}) {
  return (
    <div className="grid h-full min-h-0 w-full overflow-hidden bg-dashboard-bg lg:grid-cols-[18rem_minmax(0,1fr)]">
      {props.rail}
      <div className="flex min-h-0 min-w-0 flex-col">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 border-b border-dashboard-border px-6 py-2.5 sm:px-8">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="m-0 min-w-0 font-display text-base leading-snug font-semibold break-words text-dashboard-text">
              {props.title}
            </h1>
            <WalkthroughMeta version={props.version} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <WalkthroughVersions version={props.version} />
            {props.action}
          </div>
        </header>
        {/* The side panel starts at the header rule, so its border meets it. */}
        <div className="grid min-h-0 min-w-0 flex-1 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <main
            className="thin-scrollbar min-h-0 overflow-y-auto overscroll-contain"
            ref={props.mainRef}
          >
            {props.children}
          </main>
          {props.side}
        </div>
      </div>
    </div>
  );
}
