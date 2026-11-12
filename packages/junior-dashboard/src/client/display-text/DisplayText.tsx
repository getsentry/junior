import { memo } from "react";
import type { ActorIdentity } from "@sentry/junior/api/schema";

import { HighlightedCode } from "../code";
import { CopyButton } from "../components/CopyButton";
import { parseMarkdownBlocks } from "./codeBlocks";
import { MarkdownText } from "./markdown";
import { MentionPeopleProvider } from "./mentions";

export { KnownObjectsProvider, useTextShowsObjectCard } from "./ObjectLinks";

const NO_MENTIONS: readonly ActorIdentity[] = [];

/**
 * Render display text from the API, such as a message, summary, or preview.
 *
 * Every dashboard surface that shows this text uses this component, so
 * Markdown, Slack mentions, Slack links, Slack emoji codes, and search
 * highlights render the same way everywhere. Block mode renders full
 * Markdown and highlights fenced code. Inline mode keeps only inline
 * formatting, for one-line previews, headings, and text inside buttons.
 */
export const DisplayText = memo(function DisplayText(props: {
  /** Use the larger chat type of user and assistant messages. */
  chat?: boolean;
  /** Keep body line height compact in narrow panels. */
  compact?: boolean;
  /** Read a Markdown file, not a chat message. */
  document?: boolean;
  inline?: boolean;
  /**
   * Link people to their page. Set false inside a button, which cannot hold
   * a link. Inline mode never links other URLs.
   */
  links?: boolean;
  /** People that the API resolved for this text. */
  mentions?: readonly ActorIdentity[];
  text: string;
}) {
  return (
    <MentionPeopleProvider
      links={props.links ?? true}
      mentions={props.mentions ?? NO_MENTIONS}
    >
      {props.inline ? (
        <MarkdownText inline text={props.text} />
      ) : props.document ? (
        // One tree, so reference links and footnotes resolve across fences.
        <MarkdownText document text={props.text} />
      ) : (
        <DisplayTextBlocks
          chat={props.chat}
          compact={props.compact}
          text={props.text}
        />
      )}
    </MentionPeopleProvider>
  );
});

function DisplayTextBlocks(props: {
  chat?: boolean;
  compact?: boolean;
  text: string;
}) {
  return (
    <div className="grid min-w-0 gap-2">
      {parseMarkdownBlocks(props.text).map((block, index) => {
        if (block.language === "markdown" && !block.fenced) {
          return (
            <MarkdownText
              chat={props.chat}
              compact={props.compact}
              key={index}
              text={block.code}
            />
          );
        }

        return (
          <div
            className="group/code relative min-w-0 overflow-hidden rounded-md border border-dashboard-border-subtle bg-dashboard-surface-panel py-2.5 pl-3 pr-10"
            // A quote of selected text reads it for the code fence.
            data-code-language={
              block.language === "markdown" ? undefined : block.language
            }
            key={index}
          >
            <HighlightedCode code={block.code} language={block.language} />
            {/* Touch screens cannot hover, so keep the button visible there. */}
            <div className="absolute right-0.5 top-0.5 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/code:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/code:opacity-100">
              <CopyButton getText={() => block.code} label="Copy code" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
