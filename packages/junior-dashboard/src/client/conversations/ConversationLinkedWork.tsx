import type { ObjectType } from "@sentry/junior-plugin-api";
import type { ReactNode } from "react";
import type {
  ConversationDetailReport,
  ConversationWatch,
} from "@sentry/junior/api/schema";

import { ObjectIcon } from "../components/ObjectIcon";
import { Collapsible } from "../components/ui/collapsible";
import { WatchDetails, WatchDetailsRow } from "./ConversationWatches";
import { DetailsList, DetailsRow, DetailsRowLine } from "./DetailsList";

type ConversationAnnotation = NonNullable<
  ConversationDetailReport["annotations"]
>[number];

/** One annotation that links to work outside Junior. */
export type ConversationLink = {
  description?: string;
  facts?: { type: string };
  key: string;
  label: string;
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
      const objectType =
        annotation.objectType ??
        detail?.sidebarAnnotations?.find(
          (sidebar) => sidebar.key === annotation.key,
        )?.objectType ??
        "item";
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
 * rows keep the same space, so their statuses stay aligned.
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
        const row = <LinkRow link={link} />;
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

function LinkRow(props: { link: ConversationLink }) {
  const { link } = props;
  const status = linkStatusLabel(link.status);
  return (
    <DetailsRow
      href={link.url}
      icon={
        // The row text names the status, so the icon stays silent.
        <ObjectIcon
          decorative
          facts={link.facts}
          objectType={link.objectType}
          size={14}
          status={link.status}
        />
      }
      meta={status}
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
