import type { ReactNode } from "react";

import { ObjectIcon } from "../components/ObjectIcon";
import { slackLocationLabel } from "../format";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { conversationLinks, linkStatusLabel } from "./ConversationLinkedWork";
import { SlackMark } from "./SlackMark";

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

function ContextTag(props: {
  className?: string;
  /** Text after the label that names the object, such as a pull request title. */
  detail?: string;
  href?: string;
  icon: ReactNode;
  label: string;
  title?: string;
}) {
  const className = cn(
    "group/context-tag inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-dashboard-border-subtle px-1.5 font-sans text-2xs font-medium text-dashboard-text-muted",
    props.className,
  );
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

  return props.href ? (
    <a
      className={cn(
        className,
        "no-underline transition-colors hover:border-dashboard-border-strong hover:bg-dashboard-fill-soft hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus",
      )}
      href={props.href}
      rel="noreferrer"
      target="_blank"
      title={props.title ?? props.label}
    >
      {content}
    </a>
  ) : (
    <span className={className} title={props.label}>
      {content}
    </span>
  );
}

function GitHubMark() {
  return (
    <svg
      aria-label="GitHub"
      className="size-3 shrink-0 transition-colors group-hover/context-tag:text-dashboard-text-solid group-focus-visible/context-tag:text-dashboard-text-solid"
      fill="currentColor"
      role="img"
      viewBox="0 0 24 24"
    >
      {/* Keep the geometry from packages/docs/public/integrations/github.svg. */}
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
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
      {repository ? <ContextTag {...repository} icon={<GitHubMark />} /> : null}
    </div>
  );
}
