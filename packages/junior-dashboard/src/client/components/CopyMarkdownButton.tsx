import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "./Button";

/** Copy an available Markdown document while exposing clipboard result state. */
export function CopyMarkdownButton(props: { getMarkdown?: () => string }) {
  const [status, setStatus] = useState<"copied" | "failed" | "idle">("idle");
  const label =
    status === "copied"
      ? "Copied"
      : status === "failed"
        ? "Copy failed"
        : "Copy as Markdown";
  const Icon = status === "copied" ? Check : Copy;

  async function copyMarkdown() {
    if (!props.getMarkdown) return;

    try {
      await navigator.clipboard.writeText(props.getMarkdown());
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <Button
      aria-label={label}
      disabled={!props.getMarkdown}
      onClick={() => void copyMarkdown()}
      size="icon"
      title={label}
    >
      <Icon aria-hidden="true" size={15} strokeWidth={2} />
    </Button>
  );
}
