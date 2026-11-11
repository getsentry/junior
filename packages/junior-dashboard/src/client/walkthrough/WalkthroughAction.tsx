import { BookOpenText } from "lucide-react";
import type { ObjectFacts } from "@sentry/junior-plugin-api";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { useStartWalkthrough, useWalkthroughsEnabled } from "./walkthroughApi";
import type { WalkthroughTarget } from "./walkthroughModel";

/** The code change that an object's facts name, if they name one. */
function walkthroughTarget(
  plugin: string,
  facts: ObjectFacts | undefined,
): WalkthroughTarget | undefined {
  return facts?.type === "code_change" && facts.repository && facts.number
    ? { provider: plugin, repository: facts.repository, number: facts.number }
    : undefined;
}

/** Whether a Walkthrough action shows for this object. */
export function useWalkthroughTarget(
  plugin: string,
  facts: ObjectFacts | undefined,
): WalkthroughTarget | undefined {
  const enabled = useWalkthroughsEnabled();
  return enabled ? walkthroughTarget(plugin, facts) : undefined;
}

/**
 * Start a Walkthrough of a code change and open it. `card` shows a label for
 * the footer of a transcript card; `icon` fits beside a Linked work row.
 */
export function WalkthroughAction(props: {
  target: WalkthroughTarget;
  variant: "card" | "icon";
}) {
  const start = useStartWalkthrough();
  if (props.variant === "card") {
    return (
      <button
        className="inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 font-medium text-dashboard-text hover:underline focus-visible:outline-dashboard-focus disabled:cursor-wait disabled:opacity-60"
        disabled={start.isPending}
        onClick={() => start.mutate(props.target)}
        type="button"
      >
        <BookOpenText aria-hidden="true" size={14} />
        Walkthrough
      </button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label="Walkthrough"
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-dashboard-text-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus disabled:cursor-wait disabled:opacity-60"
            disabled={start.isPending}
            onClick={() => start.mutate(props.target)}
            type="button"
          >
            <BookOpenText aria-hidden="true" size={14} />
          </button>
        }
      />
      <TooltipContent size="compact">Open a Walkthrough</TooltipContent>
    </Tooltip>
  );
}
