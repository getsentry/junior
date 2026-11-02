import { memo } from "react";
import type { ActorIdentity } from "@sentry/junior/api/schema";

import { HighlightedCode } from "../code";
import { parseMarkdownBlocks } from "../format";
import { MarkdownText } from "./markdown";
import { MentionPeopleProvider } from "./mentions";

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
      ) : (
        <DisplayTextBlocks chat={props.chat} text={props.text} />
      )}
    </MentionPeopleProvider>
  );
});

function DisplayTextBlocks(props: { chat?: boolean; text: string }) {
  return (
    <div className="grid min-w-0 gap-2">
      {parseMarkdownBlocks(props.text).map((block, index) => {
        if (block.language === "markdown" && !block.fenced) {
          return (
            <MarkdownText chat={props.chat} key={index} text={block.code} />
          );
        }

        return (
          <div
            className="min-w-0 overflow-hidden rounded-md border border-dashboard-border-subtle bg-dashboard-surface-panel px-3 py-2.5"
            key={index}
          >
            <HighlightedCode code={block.code} language={block.language} />
          </div>
        );
      })}
    </div>
  );
}
