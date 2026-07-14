import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { codeToHtml } from "shiki/bundle/web";

import {
  HighlightedCodeFallback,
  HighlightedCodeHtml,
  type ShikiHtml,
} from "../code";
import { cn } from "../styles";
import {
  buildTranscriptMarkdownDecorations,
  findTranscriptMarkdownLinks,
  TRANSCRIPT_ANCHOR_CLASS,
} from "./transcriptMarkdownLinks";
import {
  buildSearchDecorations,
  useTranscriptSearch,
} from "./transcriptSearch";

const TRANSCRIPT_MARKDOWN_CACHE_KEY = "transcript-markdown";

/** Render transcript markdown source with Shiki highlighting and safe links. */
export function TranscriptMarkdown(props: { compact?: boolean; text: string }) {
  const search = useTranscriptSearch();
  const links = findTranscriptMarkdownLinks(props.text);
  const decorations = [
    ...buildTranscriptMarkdownDecorations(links),
    ...(search.active
      ? buildSearchDecorations(props.text, search.normalizedQuery)
      : []),
  ];
  const highlighted = useQuery({
    queryKey: [
      "highlight",
      "markdown",
      props.text,
      TRANSCRIPT_MARKDOWN_CACHE_KEY,
      ...(search.active ? [search.normalizedQuery] : []),
    ],
    queryFn: async (): Promise<ShikiHtml> =>
      (await codeToHtml(props.text, {
        decorations,
        lang: "markdown",
        theme: "github-dark",
      })) as ShikiHtml,
    staleTime: Infinity,
  });

  if (!highlighted.data) {
    return (
      <div
        className={cn(
          props.compact && "[&_pre]:!text-[0.9rem] [&_pre]:!leading-[1.6rem]",
        )}
      >
        <HighlightedCodeFallback variant="prose">
          {renderMarkdownInline(props.text, links)}
        </HighlightedCodeFallback>
      </div>
    );
  }

  return (
    <div
      className={cn(
        props.compact && "[&_pre]:!text-[0.9rem] [&_pre]:!leading-[1.6rem]",
      )}
    >
      <HighlightedCodeHtml html={highlighted.data} variant="prose" />
    </div>
  );
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
