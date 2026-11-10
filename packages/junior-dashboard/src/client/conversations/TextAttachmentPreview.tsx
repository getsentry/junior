import type { MessageAttachment } from "@sentry/junior/api/schema";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useId, useState } from "react";
import { createPortal } from "react-dom";

import { HighlightedCode, HighlightedCodeFallback } from "../code";
import { Drawer } from "../components/Drawer";
import { InlineError } from "../components/InlineError";
import { buttonVariants } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { DisplayText } from "../display-text/DisplayText";
import { readDashboardBytes } from "../http";
import {
  decodeTextPreview,
  TEXT_PREVIEW_MAX_BYTES,
  type TextPreviewLanguage,
} from "./textPreview";

type MarkdownView = "formatted" | "raw";

const SKELETON_LINE_WIDTHS = ["w-3/4", "w-full", "w-5/6", "w-2/3", "w-full"];

/**
 * Show one stored text file in a drawer. The dashboard reads the bytes and
 * renders them itself. The server keeps sending the file as a download, so a
 * stored HTML or SVG file never runs in the dashboard origin.
 */
export function TextAttachmentPreview(props: {
  attachment: MessageAttachment;
  href: string;
  language: TextPreviewLanguage;
  meta: string;
  onClose(): void;
}) {
  const titleId = useId();
  const { bytes, filename } = props.attachment;
  const truncated = bytes > TEXT_PREVIEW_MAX_BYTES;
  const markdown = props.language === "markdown";
  const [view, setView] = useState<MarkdownView>("formatted");
  const text = useQuery({
    queryKey: ["attachment-text", props.href, bytes, truncated],
    // An empty file has no byte range to read.
    queryFn: async ({ signal }) =>
      bytes === 0
        ? ""
        : (decodeTextPreview(
            await readDashboardBytes(
              props.href,
              TEXT_PREVIEW_MAX_BYTES,
              signal,
            ),
            truncated,
          ) ?? null),
    staleTime: Infinity,
  });

  return createPortal(
    <Drawer
      actions={
        <>
          {markdown ? (
            <ToggleGroup
              aria-label="Markdown view"
              onValueChange={(values) => {
                const next = values[0];
                if (next) setView(next);
              }}
              value={[view]}
            >
              <ToggleGroupItem value="formatted">Formatted</ToggleGroupItem>
              <ToggleGroupItem value="raw">Raw</ToggleGroupItem>
            </ToggleGroup>
          ) : null}
          <a
            aria-label={`Download ${filename}`}
            className={buttonVariants({ size: "icon" })}
            download={filename}
            href={props.href}
            rel="noreferrer"
            // An installed iOS home screen app has no back button.
            target="_blank"
          >
            <Download aria-hidden="true" size={15} />
          </a>
        </>
      }
      closeLabel={`Close ${filename}`}
      header={
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <h2
            className="m-0 font-mono text-sm font-semibold text-dashboard-text"
            id={titleId}
          >
            {filename}
          </h2>
          <div className="font-mono text-xs text-dashboard-text-muted">
            {props.meta}
          </div>
        </div>
      }
      onClose={props.onClose}
      openKey={titleId}
      titleId={titleId}
      width="wide"
    >
      {text.isPending ? (
        <div aria-label="Loading file" className="grid gap-2" role="status">
          {SKELETON_LINE_WIDTHS.map((width, index) => (
            <Skeleton className={`h-4 ${width}`} key={index} />
          ))}
        </div>
      ) : text.isError ? (
        <InlineError>Could not load this file.</InlineError>
      ) : text.data === null ? (
        <p className="m-0 text-sm text-dashboard-text-muted">
          This file is not text. Download it to open it.
        </p>
      ) : (
        <div className="grid min-w-0 gap-3">
          {truncated ? (
            <p className="m-0 text-xs text-dashboard-text-muted">
              Showing the first {TEXT_PREVIEW_MAX_BYTES / 1024} KB. Download the
              file to see all of it.
            </p>
          ) : null}
          <TextPreviewBody
            language={props.language}
            text={text.data}
            view={view}
          />
        </div>
      )}
    </Drawer>,
    document.body,
  );
}

function TextPreviewBody(props: {
  language: TextPreviewLanguage;
  text: string;
  view: MarkdownView;
}) {
  if (!props.text) {
    return <p className="m-0 text-sm text-dashboard-text-muted">Empty file.</p>;
  }
  if (props.language === "markdown" && props.view === "formatted") {
    return <DisplayText document text={props.text} />;
  }
  if (props.language === "plain") {
    return <HighlightedCodeFallback>{props.text}</HighlightedCodeFallback>;
  }
  return <HighlightedCode code={props.text} language={props.language} />;
}
