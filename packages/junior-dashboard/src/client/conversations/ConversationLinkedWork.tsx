import type { ObjectFacts, ObjectType } from "@sentry/junior-plugin-api";
import type { ReactNode } from "react";
import type {
  ConversationDetailReport,
  ConversationWatch,
} from "@sentry/junior/api/schema";

import { ObjectIcon } from "../components/ObjectIcon";
import { Collapsible } from "../components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import {
  WalkthroughAction,
  useWalkthroughTarget,
} from "../walkthrough/WalkthroughAction";
import { WatchDetails, WatchDetailsRow } from "./ConversationWatches";
import { DetailsList, DetailsRow, DetailsRowLine } from "./DetailsList";

type ConversationAnnotation = NonNullable<
  ConversationDetailReport["annotations"]
>[number];

/** One annotation that links to work outside Junior. */
export type ConversationLink = {
  description?: string;
  facts?: ObjectFacts;
  key: string;
  label: string;
  objectType: ObjectType;
  plugin: string;
  /** The plugin's compact row label, such as the repository name. */
  shortLabel?: string;
  status?: string;
  url: string;
};

const resourceLinkStatusLabels: Record<string, string> = {
  closed: "Closed",
  draft: "Draft",
  merged: "Merged",
  open: "Open",
  warning: "Needs attention",
};

/** Name a link status for a reader, such as "Merged" for `merged`. */
export function linkStatusLabel(status: string | undefined): string {
  if (!status) return "";
  return (
    resourceLinkStatusLabels[status] ??
    status.charAt(0).toUpperCase() + status.slice(1)
  );
}

/**
 * Pick the annotations that link to outside work, newest first as saved. A
 * resource link without an object type takes the type of its sidebar
 * annotation.
 */
export function conversationLinks(
  detail:
    | Pick<ConversationDetailReport, "annotations" | "sidebarAnnotations">
    | undefined,
): ConversationLink[] {
  return (detail?.annotations ?? []).flatMap(
    (annotation: ConversationAnnotation): ConversationLink[] => {
      if (!annotation.url) return [];
      const sidebar = detail?.sidebarAnnotations?.find(
        (candidate) => candidate.key === annotation.key,
      );
      const objectType = annotation.objectType ?? sidebar?.objectType ?? "item";
      const description =
        annotation.kind === "object"
          ? annotation.title !== annotation.label
            ? annotation.title
            : annotation.description
          : annotation.description;
      return [
        {
          ...(description ? { description } : undefined),
          ...(annotation.kind === "object" && annotation.facts
            ? { facts: annotation.facts }
            : undefined),
          key: `${annotation.plugin}:${annotation.key}`,
          label: annotation.label,
          objectType,
          plugin: annotation.plugin,
          ...(sidebar ? { shortLabel: sidebar.label } : undefined),
          ...(annotation.status ? { status: annotation.status } : undefined),
          url: annotation.url,
        },
      ];
    },
  );
}

/**
 * Show the outside work that a Conversation links to, one row each. A row
 * that Junior also watches shows the Watch details under a chevron, so the
 * same resource does not show twice. When one row has a chevron, the other
 * rows keep the same space, so all rows keep the same width.
 */
export function ConversationLinkedWork(props: {
  links: ConversationLink[];
  /** Watches by the URL of the resource that they watch. */
  watchesByUrl: ReadonlyMap<string, ConversationWatch[]>;
}) {
  return (
    <DetailsList
      itemKey={(link) => link.key}
      items={props.links}
      renderItem={(link) => {
        const row = <LinkRowWithActions link={link} />;
        const watches = props.watchesByUrl.get(link.url);
        if (!watches) {
          return props.watchesByUrl.size > 0 ? (
            <ChevronSpace>{row}</ChevronSpace>
          ) : (
            row
          );
        }
        return (
          <Collapsible className="min-w-0">
            <WatchDetailsRow label={link.label}>{row}</WatchDetailsRow>
            <WatchDetails watches={watches} />
          </Collapsible>
        );
      }}
    />
  );
}

/** Keep the width of the `WatchDetailsRow` chevron beside a row with none. */
function ChevronSpace(props: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-0.5">
      <div className="min-w-0 flex-1">{props.children}</div>
      <span aria-hidden="true" className="size-8 shrink-0" />
    </div>
  );
}

/** A row with the actions its object supports, such as a Walkthrough. */
function LinkRowWithActions(props: { link: ConversationLink }) {
  const walkthrough = useWalkthroughTarget(props.link.plugin, props.link.facts);
  if (!walkthrough) return <ConversationLinkRow link={props.link} />;
  return (
    <div className="flex min-w-0 items-start gap-0.5">
      <div className="min-w-0 flex-1">
        <ConversationLinkRow link={props.link} />
      </div>
      <WalkthroughAction target={walkthrough} variant="icon" />
    </div>
  );
}

/** One linked-work row: the object's icon, label, and description. */
export function ConversationLinkRow(props: { link: ConversationLink }) {
  const { link } = props;
  const status = linkStatusLabel(link.status);
  const icon = (
    <ObjectIcon
      decorative
      facts={link.facts}
      objectType={link.objectType}
      size={14}
      status={link.status}
    />
  );
  return (
    <DetailsRow
      href={link.url}
      icon={
        // The icon shows the status, so the row does not repeat it in text.
        status ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span aria-label={status} className="inline-flex" role="img">
                  {icon}
                </span>
              }
            />
            <TooltipContent size="compact">{status}</TooltipContent>
          </Tooltip>
        ) : (
          icon
        )
      }
      title={link.label}
      tooltip={[link.label, link.plugin, status, link.description]
        .filter(Boolean)
        .join(" · ")}
    >
      {link.description ? (
        <DetailsRowLine className="line-clamp-2 break-words">
          {link.description}
        </DetailsRowLine>
      ) : null}
    </DetailsRow>
  );
}
