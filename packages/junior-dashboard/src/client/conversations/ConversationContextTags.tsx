import type { ReactNode } from "react";

import { slackLocationLabel } from "../format";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { GitHubMark } from "./GitHubMark";
import { SlackMark } from "./SlackMark";
import { OutboundLink } from "../components/OutboundLink";

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
  href?: string;
  icon: ReactNode;
  label: string;
  title?: string;
}) {
  const className =
    "group/context-tag inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-dashboard-border-subtle px-1.5 font-sans text-2xs font-medium text-dashboard-text-muted";
  const content = (
    <>
      {props.icon}
      <span className="truncate">{props.label}</span>
    </>
  );

  return props.href ? (
    <OutboundLink
      className={cn(
        className,
        "no-underline transition-colors hover:border-dashboard-border-strong hover:bg-dashboard-fill-soft hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus",
      )}
      href={props.href}
      title={props.title ?? props.label}
    >
      {content}
    </OutboundLink>
  ) : (
    <span className={className} title={props.label}>
      {content}
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
      {location ? (
        <ContextTag
          href={conversation?.locationUrl}
          icon={
            <SlackMark className="size-3 shrink-0 group-hover/context-tag:[&>path]:fill-(--slack-mark-color) group-focus-visible/context-tag:[&>path]:fill-(--slack-mark-color)" />
          }
          label={location}
          title={`Open ${location} in Slack`}
        />
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
