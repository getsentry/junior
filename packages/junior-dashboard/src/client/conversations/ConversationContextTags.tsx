import type { ReactNode } from "react";

import { ObjectIcon } from "../components/ObjectIcon";
import { Badge } from "../components/ui/badge";
import { slackLocationLabel } from "../format";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { conversationLinks, linkStatusLabel } from "./ConversationLinkedWork";
import { GitHubMark } from "./GitHubMark";
import { SlackMark } from "./SlackMark";
import { OutboundLink } from "../components/OutboundLink";

/** Linked work tags shown on a home card before the rest collapse into +N. */
const MAX_CARD_LINK_TAGS = 2;

function githubRepositoryFromUrl(href: string) {
  const url = new URL(href);
  if (url.origin !== "https://github.com") return undefined;
  const [, owner, repo] = url.pathname.split("/");
  if (!owner || !repo) return undefined;
  return {
    label: `${owner}/${repo}`,
    href: `${url.origin}/${owner}/${repo}`,
  };
}

function singleGitHubRepository(annotations: Conversation["annotations"]) {
  let repository: ReturnType<typeof githubRepositoryFromUrl>;
  for (const annotation of annotations ?? []) {
    if (annotation.plugin !== "github" || !annotation.url) continue;
    const candidate = githubRepositoryFromUrl(annotation.url);
    if (!candidate) continue;
    if (
      repository &&
      repository.href.toLowerCase() !== candidate.href.toLowerCase()
    ) {
      return undefined;
    }
    repository ??= candidate;
  }
  return repository;
}

/** A compact header tag: an icon and a label, optionally an outbound link. */
export function ContextTag(props: {
  className?: string | undefined;
  /** Text after the label that names the object, such as a pull request title. */
  detail?: string | undefined;
  href?: string | undefined;
  icon: ReactNode;
  label: string;
  title?: string;
}) {
  const content = (
    <>
      {props.icon}
      <span className={props.detail ? "shrink-0" : "truncate"}>
        {props.label}
      </span>
      {props.detail ? (
        <span className="truncate font-normal text-dashboard-text">
          {props.detail}
        </span>
      ) : null}
    </>
  );

  return (
    <Badge
      className={cn(
        "group/context-tag inline-flex h-6 min-w-0 items-center gap-1 font-medium",
        props.className,
      )}
      render={props.href ? <OutboundLink href={props.href} /> : undefined}
      title={props.title ?? props.label}
      variant="outline"
    >
      {content}
    </Badge>
  );
}

function SlackLocationTag(props: {
  className?: string;
  conversation: Conversation;
}) {
  const location = slackLocationLabel(props.conversation, { includeId: false });
  if (!location) return null;
  return (
    <ContextTag
      className={props.className}
      href={props.conversation.locationUrl}
      icon={
        <SlackMark className="size-3 shrink-0 group-hover/context-tag:[&>path]:fill-(--slack-mark-color) group-focus-visible/context-tag:[&>path]:fill-(--slack-mark-color)" />
      }
      label={location}
      title={`Open ${location} in Slack`}
    />
  );
}

/**
 * Show where a home card came from and the work it links to. Each linked
 * work tag already names its source, such as the repository, so the card
 * has no separate repository tag.
 */
export function conversationCardTags(
  conversation: Conversation,
  title: string,
) {
  const location = slackLocationLabel(conversation, { includeId: false });
  // A direct message is often titled "Direct Message", like its location.
  const showLocation = Boolean(location) && location !== title;
  const links = conversationLinks(conversation);
  if (!showLocation && links.length === 0) return null;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {showLocation ? (
        <SlackLocationTag
          className="max-w-40 shrink-0"
          conversation={conversation}
        />
      ) : null}
      {links.slice(0, MAX_CARD_LINK_TAGS).map((link, index) => (
        <ContextTag
          // Narrow screens fit one linked work tag.
          className={cn("max-w-96", index > 0 && "max-sm:hidden")}
          detail={link.description}
          href={link.url}
          icon={
            <ObjectIcon
              decorative
              facts={link.facts}
              objectType={link.objectType}
              size={12}
              status={link.status}
            />
          }
          key={link.key}
          // With a title, the compact label is enough to name the source.
          label={(link.description && link.shortLabel) || link.label}
          title={[link.label, linkStatusLabel(link.status), link.description]
            .filter(Boolean)
            .join(" · ")}
        />
      ))}
      <HiddenLinkCount className="sm:hidden" count={links.length - 1} />
      <HiddenLinkCount
        className="max-sm:hidden"
        count={links.length - MAX_CARD_LINK_TAGS}
      />
    </div>
  );
}

function HiddenLinkCount(props: { className: string; count: number }) {
  if (props.count <= 0) return null;
  return (
    <span
      className={cn(
        "shrink-0 font-sans text-2xs tabular-nums text-dashboard-text-muted",
        props.className,
      )}
    >
      +{props.count}
    </span>
  );
}

/** Show source context and a repository tag when linked work points to one repository. */
export function conversationContextTags(
  conversation: Conversation | undefined,
) {
  const location =
    conversation && slackLocationLabel(conversation, { includeId: false });
  const repository = singleGitHubRepository(conversation?.annotations);
  if (!location && !repository) return null;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {location && conversation ? (
        <SlackLocationTag conversation={conversation} />
      ) : null}
      {repository ? (
        <ContextTag
          {...repository}
          icon={
            <GitHubMark className="size-3 shrink-0 transition-colors group-hover/context-tag:text-dashboard-text-solid group-focus-visible/context-tag:text-dashboard-text-solid" />
          }
        />
      ) : null}
    </div>
  );
}
