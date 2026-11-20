import { GitHubMark } from "./GitHubMark";
import { SlackMark } from "./SlackMark";
import type { SourceProvider } from "./transcriptSource";

const SOURCE_MARKS = {
  github: { label: "GitHub", Mark: GitHubMark },
  slack: { label: "Slack", Mark: SlackMark },
} satisfies Record<SourceProvider, unknown>;

/** Render the provider mark next to transcript message metadata. */
export function SourceMark(props: { provider: SourceProvider }) {
  const { label, Mark } = SOURCE_MARKS[props.provider];
  return (
    <span className="inline-flex shrink-0 self-center" title={label}>
      <Mark className="size-3.5" />
    </span>
  );
}
