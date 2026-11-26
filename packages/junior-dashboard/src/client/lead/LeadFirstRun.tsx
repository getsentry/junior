import { ArrowUpRight } from "lucide-react";
import { type RefObject, useCallback, useEffect } from "react";

import { LeadMark } from "./LeadMark";

const FEATURES = [
  {
    about: "Each request becomes its own Thread that runs as you.",
    title: "Starts work",
  },
  {
    about: "It follows the ones you ask about and reports back here.",
    title: "Keeps watch",
  },
  {
    about: "It can find any conversation you're in and send it follow-ups.",
    title: "Finds and steers",
  },
];

const PROMPTS = [
  "Find out why checkout got slow this morning",
  "What's waiting on me?",
  "Tell the billing migration Thread to skip the dry run",
];

/** The Lead's reply box placeholder. */
export const LEAD_REPLY_PLACEHOLDER =
  "Ask the Lead to start, find, or check on work…";

/**
 * Show the first-run intro on an empty Lead and focus its reply box. The
 * intro's prompts and the transcript's rows fill the box with `prefill`.
 */
export function useLeadFirstRun(
  shown: boolean,
  replyRef: RefObject<{ appendText(text: string): void; focus(): void } | null>,
) {
  const prefill = useCallback(
    (text: string) => replyRef.current?.appendText(text),
    [replyRef],
  );
  useFocusOnLeadFirstRun(shown, replyRef);
  return { prefill, shown };
}

/** Focus the Lead's reply box while the first-run intro shows. */
function useFocusOnLeadFirstRun(
  shown: boolean,
  replyRef: RefObject<{ focus(): void } | null>,
) {
  useEffect(() => {
    // On a touch screen, focus would open the keyboard over the intro.
    if (shown && window.matchMedia("(pointer: fine)").matches) {
      replyRef.current?.focus();
    }
  }, [replyRef, shown]);
}

/**
 * Introduce an empty Lead: what it does, and prompts that fill the reply
 * box.
 */
export function LeadFirstRun(props: { onTry(text: string): void }) {
  return (
    <section
      aria-label="About this Space's Lead"
      className="grid justify-items-center gap-6 px-1 py-8 text-center md:py-14"
    >
      <LeadMark size="intro" />
      <div className="grid max-w-[34rem] gap-3">
        <h2 className="font-display text-2xl font-semibold text-dashboard-text md:text-3xl">
          This Space&apos;s Lead
        </h2>
        <p className="font-sans text-sm leading-relaxed text-dashboard-text-muted">
          Tell it what you need done. It starts a conversation in this Space for
          each piece of work, keeps track of them, and tells you when one needs
          you. Every member of the Space talks to it here.
        </p>
      </div>
      <ul className="grid w-full gap-2 text-left sm:grid-cols-3">
        {FEATURES.map((feature) => (
          <li
            className="rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel p-3"
            key={feature.title}
          >
            <p className="font-sans text-sm font-medium text-dashboard-text">
              {feature.title}
            </p>
            <p className="mt-1 font-sans text-xs leading-relaxed text-dashboard-text-muted">
              {feature.about}
            </p>
          </li>
        ))}
      </ul>
      <div className="grid w-full gap-1.5 text-left">
        <p className="px-1 font-sans text-xs font-medium text-dashboard-text-faint">
          Try
        </p>
        <ul className="grid gap-1">
          {PROMPTS.map((prompt) => (
            <li key={prompt}>
              <button
                className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-sans text-sm text-dashboard-text-muted transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text"
                onClick={() => props.onTry(prompt)}
                type="button"
              >
                <span className="min-w-0 flex-1">{prompt}</span>
                <ArrowUpRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-dashboard-text-faint group-hover:text-dashboard-text"
                />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
