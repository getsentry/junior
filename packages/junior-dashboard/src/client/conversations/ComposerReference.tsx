import { Bot, Brain, FileText, MessageSquare } from "lucide-react";

import { usePlainLinks } from "../display-text/DisplayText";
import { cn } from "../styles";
import { codeChangeTone } from "./ConversationMeta";
import { ConversationStateIcon } from "./ConversationStateIcon";
import { GitHubMark } from "./GitHubMark";
import { codeChangeLabel, type ComposerReference } from "./composerReferences";

/**
 * The icon of a reference: the state of a Conversation, a bot for a Task or
 * Thread, a brain for a memory, a file, or the GitHub mark in the color of
 * the pull request state. A channel has none: its `#` says what it is.
 */
export function ReferenceIcon(props: {
  className?: string;
  reference: ComposerReference;
}) {
  const { reference } = props;
  const className = cn("size-3.5 shrink-0", props.className);
  switch (reference.kind) {
    case "conversation":
      return reference.state ? (
        // It has its own size.
        <ConversationStateIcon
          className={props.className}
          state={reference.state}
        />
      ) : (
        <MessageSquare aria-hidden="true" className={className} />
      );
    case "task":
      return <Bot aria-hidden="true" className={className} />;
    case "memory":
      return <Brain aria-hidden="true" className={className} />;
    case "file":
      return <FileText aria-hidden="true" className={className} />;
    case "code_change":
      return (
        <GitHubMark
          className={cn(
            className,
            reference.state &&
              codeChangeTone(reference.state, reference.draft ?? false)
                .className,
          )}
        />
      );
    case "channel":
      return null;
  }
}

/** The name that a reference chip and its menu row show. */
export function referenceName(reference: ComposerReference): string {
  switch (reference.kind) {
    case "conversation":
    case "task":
    case "memory":
      return reference.title;
    case "code_change":
      return codeChangeLabel(reference);
    case "channel":
      return `#${reference.name}`;
    case "file":
      return reference.name;
  }
}

/**
 * A Conversation, Task, memory, file, pull request, or channel in the
 * composer: its icon and name, cut off with an ellipsis at about 14rem. A
 * pull request shows `repo#123`. The full name is its tooltip. Plain links
 * show no icon.
 */
export function ComposerReferenceChip(props: { reference: ComposerReference }) {
  const { reference } = props;
  const plain = usePlainLinks();
  const fullName = referenceName(reference);
  const name =
    reference.kind === "code_change"
      ? `${reference.repository.split("/").at(-1)}#${reference.number}`
      : fullName;
  return (
    <span
      className="inline-flex max-w-56 items-baseline gap-1 rounded-sm align-bottom font-medium whitespace-nowrap text-dashboard-accent-text"
      data-reference={reference.kind}
      title={fullName}
    >
      {plain ? null : (
        <ReferenceIcon className="self-center" reference={reference} />
      )}
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}
