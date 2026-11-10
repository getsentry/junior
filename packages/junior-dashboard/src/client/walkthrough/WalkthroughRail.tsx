import type { WalkthroughDocument } from "@sentry/junior/api/schema";

import { ConversationLinkedWork } from "../conversations/ConversationLinkedWork";
import { DetailsCard } from "../conversations/DetailsList";
import { cn } from "../styles";
import {
  stepChapter,
  stepTitle,
  typeLabels,
  type WalkthroughStep,
} from "./walkthroughModel";

const NO_WATCHES = new Map();

/** The pull requests, then the steps in reading order. */
export function WalkthroughRail(props: {
  activeKey: string;
  document: WalkthroughDocument;
  onSelect(key: string): void;
  steps: readonly WalkthroughStep[];
}) {
  const { document } = props;
  // Layers are stored bottom first. Read the stack top down, like GitHub.
  const links = [...document.layers].reverse().map((layer) => ({
    description: `#${layer.pr} · +${layer.additions} −${layer.deletions}`,
    key: `github:${layer.pr}`,
    label: layer.title,
    objectType: "code_change" as const,
    plugin: "github",
    status: "open",
    url: layer.url,
  }));
  const groups = stepGroups(document, props.steps);

  return (
    <nav aria-label="Walkthrough" className="grid content-start gap-4">
      <DetailsCard
        count={links.length > 1 ? links.length : undefined}
        flat
        title={links.length > 1 ? "Pull requests" : "Pull request"}
      >
        <ConversationLinkedWork links={links} watchesByUrl={NO_WATCHES} />
      </DetailsCard>
      <DetailsCard flat title="Steps">
        <div className="-mx-1.5 grid gap-3">
          {groups.map((group) => (
            <div className="grid gap-0.5" key={group.label ?? "steps"}>
              {group.label ? (
                <h4 className="m-0 px-1.5 pb-0.5 text-xs font-medium text-dashboard-text-faint">
                  {group.label}
                </h4>
              ) : null}
              <ol className="m-0 grid list-none gap-0.5 p-0">
                {group.steps.map(({ step, index }) => {
                  const active = step.key === props.activeKey;
                  return (
                    <li key={step.key}>
                      <button
                        aria-current={active ? "step" : undefined}
                        className={cn(
                          "flex w-full cursor-pointer items-baseline gap-2.5 rounded-md border-0 px-1.5 py-1.5 text-left text-sm",
                          active
                            ? "bg-dashboard-fill-strong text-dashboard-text"
                            : "bg-transparent text-dashboard-text-muted hover:bg-dashboard-surface-hover hover:text-dashboard-text",
                        )}
                        onClick={() => props.onSelect(step.key)}
                        type="button"
                      >
                        <span className="w-4 shrink-0 text-right text-xs tabular-nums text-dashboard-text-faint">
                          {index + 1}
                        </span>
                        <span className="min-w-0">
                          {stepTitle(document, step)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      </DetailsCard>
    </nav>
  );
}

/**
 * Group steps by change type when a Walkthrough mixes types. A single type
 * needs no group heading: the page header names it once.
 */
function stepGroups(
  document: WalkthroughDocument,
  steps: readonly WalkthroughStep[],
) {
  const groups: {
    label?: string;
    steps: { step: WalkthroughStep; index: number }[];
  }[] = [];
  // A ship check is not a type of change, so it does not make a mix.
  const types = new Set(
    steps
      .map((s) => stepChapter(document, s)?.type)
      .filter((type) => type !== "ship_check"),
  );
  steps.forEach((step, index) => {
    const type = stepChapter(document, step)?.type;
    const label = types.size > 1 && type ? typeLabels[type] : undefined;
    const last = groups.at(-1);
    if (last && last.label === label) last.steps.push({ step, index });
    else groups.push({ label, steps: [{ step, index }] });
  });
  return groups;
}
