import { objectPresentation, type ObjectType } from "@sentry/junior-plugin-api";
import { useEffect } from "react";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { ObjectIcon } from "../components/ObjectIcon";
import {
  MessageObjectsProvider,
  useResolvedObject,
} from "../display-text/DisplayText";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { githubRepositoryFromUrl } from "./ConversationContextTags";
import { objectSource } from "./objectSource";
import { DetailsRow, DetailsSection } from "./DetailsList";

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
   * The server read no card, so the row has only the label and the link.
   * The row asks for the live card, so a viewer who can open the object
   * sees its title.
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
      if (annotation.kind === "resource_link") {
        return [
          {
            key: `${annotation.plugin}:${annotation.key}`,
            label: annotation.label,
            linkOnly: true,
            objectType,
            plugin: annotation.plugin,
            url: annotation.url,
          },
        ];
      }
      const description =
        annotation.title !== annotation.label
          ? annotation.title
          : annotation.description;
      return [
        {
          ...(description ? { description } : undefined),
          ...(annotation.facts ? { facts: annotation.facts } : undefined),
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
 * Show the outside work that a Conversation links to, one row each. Merged
 * and closed work hides behind "Show finished". A ref in the conversation's
 * own repository drops the repository, so `#91` stands for
 * `getsentry/payments#91`.
 */
export function ConversationLinkedWork(props: {
  links: ConversationLink[];
  /** The one GitHub repository that the Conversation works in. */
  repository?: string | undefined;
}) {
  const row = (link: ConversationLink) =>
    link.linkOnly ? (
      <LiveLinkRow key={link.key} link={link} />
    ) : (
      <LinkRow key={link.key} link={link} repository={props.repository} />
    );
  return (
    <MessageObjectsProvider>
      <DetailsSection
        finished={props.links.filter(linkFinished).map(row)}
        rows={props.links.filter((link) => !linkFinished(link)).map(row)}
        title="Linked work"
      />
    </MessageObjectsProvider>
  );
}

function linkFinished(link: ConversationLink): boolean {
  return link.status === "merged" || link.status === "closed";
}

// Ask for the card at once: the row has no other way to start the request.
function LiveLinkRow(props: { link: ConversationLink }) {
  const { card, request } = useResolvedObject(props.link.url);
  useEffect(() => request(), [request]);
  return (
    <LinkRow link={card ? { ...props.link, label: card.title } : props.link} />
  );
}

/** Drop the repository from a ref in the conversation's own repository. */
function shortRef(link: ConversationLink, repository: string | undefined) {
  const linkRepository = githubRepositoryFromUrl(link.url)?.label;
  if (
    repository &&
    linkRepository?.toLowerCase() === repository.toLowerCase() &&
    link.label.toLowerCase().startsWith(linkRepository.toLowerCase())
  ) {
    return link.label.slice(linkRepository.length);
  }
  return link.label;
}

function LinkRow(props: {
  link: ConversationLink;
  repository?: string | undefined;
}) {
  const { link } = props;
  const status = linkStatusLabel(link.status);
  // The shape shows the state, so only a failure that has no shape for it,
  // a failed deployment or a failing monitor, keeps its color. The icon
  // also covers a deployment saved as an Item.
  const presentation = objectPresentation(link);
  const tone =
    presentation.tone === "danger" &&
    (presentation.icon === "rocket" || presentation.icon === "bell")
      ? undefined
      : "neutral";
  const icon = (
    <ObjectIcon
      decorative
      facts={link.facts}
      objectType={link.objectType}
      size={16}
      status={link.status}
      tone={tone}
    />
  );
  // An object link names its ref in the label and its title in the
  // description. Other links have only the label.
  const ref = link.description ? shortRef(link, props.repository) : undefined;
  return (
    <DetailsRow
      href={link.url}
      icon={
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
      title={
        ref ? (
          <>
            <span className="font-normal tabular-nums text-dashboard-text-muted">
              {ref}
            </span>{" "}
            {link.description}
          </>
        ) : (
          link.label
        )
      }
      tooltip={[link.label, objectSource(link.plugin), status, link.description]
        .filter(Boolean)
        .join(" · ")}
    />
  );
}
