import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "../components/Button";
import { IconButtonTooltip } from "../components/Tooltip";

/** Copy an available Markdown document while exposing clipboard result state. */
export function CopyMarkdownButton(props: {
  getMarkdown?: () => Promise<string> | string;
}) {
  const [status, setStatus] = useState<
    "copied" | "copying" | "failed" | "idle"
  >("idle");
  const label =
    status === "copied"
      ? "Copied"
      : status === "copying"
        ? "Preparing Markdown"
        : status === "failed"
          ? "Copy failed"
          : "Copy as Markdown";
  const Icon = status === "copied" ? Check : Copy;

  async function copyMarkdown() {
    if (!props.getMarkdown) return;

    try {
      setStatus("copying");
      await navigator.clipboard.writeText(await props.getMarkdown());
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <IconButtonTooltip label={label}>
      <Button
        aria-label={label}
        disabled={!props.getMarkdown || status === "copying"}
        onClick={() => void copyMarkdown()}
        size="icon"
      >
        <Icon aria-hidden="true" size={15} strokeWidth={2} />
      </Button>
    </IconButtonTooltip>
  );
}
