import type { ObjectType } from "@sentry/junior-plugin-api";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { ObjectIcon } from "../components/ObjectIcon";
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

/** Show the outside work that a Conversation links to, one row each. */
export function ConversationLinkedWork(props: { links: ConversationLink[] }) {
  return (
    <DetailsList
      itemKey={(link) => link.key}
      items={props.links}
      renderItem={(link) => {
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
      }}
    />
  );
}
