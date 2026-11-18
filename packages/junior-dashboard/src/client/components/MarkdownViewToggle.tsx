import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

/** How a drawer shows Markdown text. */
export type MarkdownView = "formatted" | "raw";

/** Switch a Markdown preview between formatted and raw text. */
export function MarkdownViewToggle(props: {
  onChange(view: MarkdownView): void;
  value: MarkdownView;
}) {
  return (
    <ToggleGroup
      aria-label="Markdown view"
      onValueChange={(values) => {
        const next = values[0];
        if (next) props.onChange(next);
      }}
      value={[props.value]}
    >
      <ToggleGroupItem value="formatted">Formatted</ToggleGroupItem>
      <ToggleGroupItem value="raw">Raw</ToggleGroupItem>
    </ToggleGroup>
  );
}
