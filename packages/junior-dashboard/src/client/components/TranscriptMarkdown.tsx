import { renderTranscriptMarkdown } from "./transcriptMarkdownRender";

/** Render transcript markdown as readable prose with GFM-style hard breaks. */
export function TranscriptMarkdown(props: { compact?: boolean; text: string }) {
  return renderTranscriptMarkdown(props);
}
