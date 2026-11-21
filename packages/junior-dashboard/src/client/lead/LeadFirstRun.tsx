import { ArrowUpRight } from "lucide-react";

import { LeadMark } from "./LeadMark";

const FEATURES = [
  {
    about: "Each request becomes its own conversation that runs as you.",
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
  "Tell the billing migration conversation to skip the dry run",
];

/**
 * Introduce an empty Lead: what it does, and prompts that fill the reply
 * box.
 */
export function LeadFirstRun(props: { onTry(text: string): void }) {
  return (
    <section
      aria-label="About your Lead"
      className="grid justify-items-center gap-6 px-1 py-8 text-center md:py-14"
    >
      <LeadMark size="intro" />
      <div className="grid max-w-[34rem] gap-3">
        <h2 className="font-display text-2xl font-semibold text-dashboard-text md:text-3xl">
          This is your Lead
        </h2>
        <p className="font-sans text-sm leading-relaxed text-dashboard-text-muted">
          Tell it what you need done. It starts a conversation for each piece of
          work, keeps track of them, and tells you when one needs you. The work
          itself happens in those conversations.
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
