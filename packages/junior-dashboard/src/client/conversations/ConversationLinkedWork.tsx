import type { ObjectType } from "@sentry/junior-plugin-api";
import { useEffect, type ReactNode } from "react";
import type {
  ConversationDetailReport,
  ConversationWatch,
} from "@sentry/junior/api/schema";

import { ObjectIcon } from "../components/ObjectIcon";
import {
  MessageObjectsProvider,
  useResolvedObject,
} from "../display-text/DisplayText";
import { Collapsible } from "../components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import {
  ConversationWatches,
  type CancelWatch,
  useCancelConversationWatch,
  useConversationWatches,
  WatchDetails,
  WatchDetailsRow,
} from "./ConversationWatches";
import { objectSource } from "./objectSource";
import {
  DetailsCard,
  DetailsList,
  DetailsRow,
  DetailsRowLine,
} from "./DetailsList";

type ConversationAnnotation = NonNullable<
  ConversationDetailReport["annotations"]
>[number];

/** One annotation that links to work outside Junior. */
export type ConversationLink = {
  description?: string;
  facts?: { type: string };
  key: string;
  label: string;
  /**
   * The Annotation saves only the link, with no title. The row asks for the
   * live card, so a viewer who can open the object sees its title.
   */
  linkOnly?: boolean;
  objectType: ObjectType;
  plugin: string;
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
  detail: ConversationDetailReport | undefined,
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
          // An older attached link uses its own URL as the label.
          ...(annotation.kind === "resource_link" &&
          annotation.url.startsWith(annotation.label)
            ? { linkOnly: true }
            : undefined),
          objectType,
          plugin: annotation.plugin,
          ...(annotation.status ? { status: annotation.status } : undefined),
          url: annotation.url,
        },
      ];
    },
  );
}

/**
 * Show the linked work of a Conversation and what Junior waits on, as one
 * list: a Watch waits on something. A Watch on linked work shows in that
 * row, so the resource shows once. Participants can cancel a Watch.
 */
export function ConversationLinkedWorkCard(props: {
  /** True when the viewer is a Participant, who can cancel Watches. */
  canCancelWatches: boolean;
  conversationId: string;
  links: ConversationLink[];
}) {
  const { links } = props;
  const allWatches =
    useConversationWatches(props.conversationId).data?.watches ?? [];
  const cancelWatch = useCancelConversationWatch(props.conversationId);
  const onCancel = props.canCancelWatches
    ? (watch: ConversationWatch) => cancelWatch.mutate(watch)
    : undefined;
  const linkUrls = new Set(links.map((link) => link.url));
  const watchesByUrl = new Map<string, ConversationWatch[]>();
  const watches: ConversationWatch[] = [];
  for (const watch of allWatches) {
    if (watch.url && linkUrls.has(watch.url)) {
      watchesByUrl.set(watch.url, [
        ...(watchesByUrl.get(watch.url) ?? []),
        watch,
      ]);
    } else {
      watches.push(watch);
    }
  }
  if (links.length === 0 && watches.length === 0) return null;
  return (
    <DetailsCard
      count={links.length || watches.length}
      title={links.length > 0 ? "Linked work" : "Waiting on"}
    >
      {links.length > 0 ? (
        <ConversationLinkedWork
          links={links}
          onCancelWatch={onCancel}
          watchesByUrl={watchesByUrl}
        />
      ) : null}
      {links.length > 0 && watches.length > 0 ? (
        <h4 className="m-0 mb-1.5 mt-3 font-sans text-xs font-semibold text-dashboard-text-muted">
          Also waiting on
        </h4>
      ) : null}
      {watches.length > 0 ? (
        <ConversationWatches onCancel={onCancel} watches={watches} />
      ) : null}
    </DetailsCard>
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
  onCancelWatch?: CancelWatch | undefined;
  /** Watches by the URL of the resource that they watch. */
  watchesByUrl: ReadonlyMap<string, ConversationWatch[]>;
}) {
  return (
    <MessageObjectsProvider>
      <DetailsList
        itemKey={(link) => link.key}
        items={props.links}
        renderItem={(link) => {
          const row = link.linkOnly ? (
            <LiveLinkRow link={link} />
          ) : (
            <LinkRow link={link} />
          );
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
              <WatchDetails
                onCancel={props.onCancelWatch}
                showTime
                watches={watches}
              />
            </Collapsible>
          );
        }}
      />
    </MessageObjectsProvider>
  );
}

// Ask for the card at once: the row has no other way to start the request.
function LiveLinkRow(props: { link: ConversationLink }) {
  const { card, request } = useResolvedObject(props.link.url);
  useEffect(() => request(), [request]);
  return (
    <LinkRow link={card ? { ...props.link, label: card.title } : props.link} />
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

function LinkRow(props: { link: ConversationLink }) {
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
      tooltip={[link.label, objectSource(link.plugin), status, link.description]
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
