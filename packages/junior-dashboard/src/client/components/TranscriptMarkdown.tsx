import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { codeToHtml } from "shiki/bundle/web";

import {
  HighlightedCodeFallback,
  HighlightedCodeHtml,
  type ShikiHtml,
} from "../code";
import {
  buildTranscriptMarkdownDecorations,
  findTranscriptMarkdownLinks,
  TRANSCRIPT_ANCHOR_CLASS,
} from "./transcriptMarkdownLinks";

const TRANSCRIPT_MARKDOWN_CACHE_KEY = "transcript-markdown";

/** Render transcript markdown source with Shiki highlighting and safe links. */
export function TranscriptMarkdown(props: { text: string }) {
  const links = findTranscriptMarkdownLinks(props.text);
  const highlighted = useQuery({
    queryKey: [
      "highlight",
      "markdown",
      props.text,
      TRANSCRIPT_MARKDOWN_CACHE_KEY,
    ],
    queryFn: async (): Promise<ShikiHtml> =>
      (await codeToHtml(props.text, {
        decorations: buildTranscriptMarkdownDecorations(links),
        lang: "markdown",
        theme: "github-dark",
      })) as ShikiHtml,
    staleTime: Infinity,
  });

  if (!highlighted.data) {
    return (
      <HighlightedCodeFallback>
        {renderMarkdownInline(props.text, links)}
      </HighlightedCodeFallback>
    );
  }

  return <HighlightedCodeHtml html={highlighted.data} />;
}

function renderMarkdownInline(
  text: string,
  links = findTranscriptMarkdownLinks(text),
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const link of links) {
    if (link.start > cursor) nodes.push(text.slice(cursor, link.start));
    nodes.push(
      <TranscriptAnchor href={link.href} key={`link-${link.start}`}>
        {link.label}
      </TranscriptAnchor>,
    );
    cursor = link.end;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function TranscriptAnchor(props: { children: ReactNode; href: string }) {
  const opensNewTab = /^https?:/i.test(props.href);
  return (
    <a
      className={TRANSCRIPT_ANCHOR_CLASS}
      href={props.href}
      rel={opensNewTab ? "noreferrer" : undefined}
      target={opensNewTab ? "_blank" : undefined}
    >
      {props.children}
    </a>
  );
}
