import { MessagesSquare } from "lucide-react";
import type {
  WalkthroughDocument,
  WalkthroughReport,
} from "@sentry/junior/api/schema";

import { ConversationLinkedWork } from "../conversations/ConversationLinkedWork";
import { DetailsRow, DetailsRowLine } from "../conversations/DetailsList";
import { conversationPath } from "../conversations/conversationRoutes";
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
  /** The Conversation that made the PR, when the viewer may read it. */
  source?: WalkthroughReport["source"];
  steps: readonly WalkthroughStep[];
}) {
  const { document } = props;
  // Layers are stored bottom first. Read the stack top down, like GitHub.
  const links = [...document.layers].reverse().map((layer) => ({
    // Same shape as the GitHub plugin's annotation, so the row matches
    // Linked work in the Conversation details panel.
    description: layer.title,
    key: `github:${layer.pr}`,
    label: `${document.repository}#${layer.pr}`,
    objectType: "code_change" as const,
    plugin: "github",
    status: "open",
    url: layer.url,
  }));
  const groups = stepGroups(document, props.steps);

  return (
    <nav
      aria-label="Walkthrough"
      className="thin-scrollbar grid min-h-0 content-start gap-6 overflow-y-auto overscroll-contain border-r border-dashboard-border bg-dashboard-surface-panel px-4 py-5 max-lg:hidden"
    >
      <section className="grid gap-2">
        <h2 className="m-0 font-sans text-sm font-semibold text-dashboard-text">
          {links.length > 1 ? "Pull requests" : "Pull request"}
        </h2>
        <ConversationLinkedWork links={links} watchesByUrl={NO_WATCHES} />
      </section>
      {props.source ? (
        <section className="grid gap-2">
          <h2 className="m-0 font-sans text-sm font-semibold text-dashboard-text">
            Made in
          </h2>
          <div className="-mx-1.5">
            {/* Same shape as the pull request row: a label, then the title. */}
            <DetailsRow
              icon={<MessagesSquare aria-hidden="true" size={14} />}
              title="Conversation"
              to={conversationPath(props.source.conversationId)}
              tooltip={props.source.title}
            >
              <DetailsRowLine className="line-clamp-2 break-words">
                {props.source.title}
              </DetailsRowLine>
            </DetailsRow>
          </div>
        </section>
      ) : null}
      <div className="-mx-1.5 grid gap-3">
        {groups.map((group) => (
          <div className="grid gap-0.5" key={group.label ?? "steps"}>
            {group.label ? (
              <h3 className="m-0 px-1.5 pb-0.5 text-xs font-medium text-dashboard-text-faint">
                {group.label}
              </h3>
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
  // A ship check is not a type of change, so it does not make a mix, and it
  // needs no heading of its own.
  const types = new Set(
    steps
      .map((s) => stepChapter(document, s)?.type)
      .filter((type) => type !== "ship_check"),
  );
  steps.forEach((step, index) => {
    const type = stepChapter(document, step)?.type;
    const last = groups.at(-1);
    // A ship check stays in the group above it.
    const label =
      type === "ship_check"
        ? last?.label
        : types.size > 1 && type
          ? typeLabels[type]
          : undefined;
    if (last && last.label === label) last.steps.push({ step, index });
    else groups.push({ label, steps: [{ step, index }] });
  });
  return groups;
}
