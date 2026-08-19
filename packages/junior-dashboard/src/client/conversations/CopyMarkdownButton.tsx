import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "../components/Button";
import { IconButtonTooltip } from "../components/Tooltip";

/** Copy an available Markdown document while exposing clipboard result state. */
export function CopyMarkdownButton(props: {
  getMarkdown?: () => Promise<string> | string;
  /** `menu` shows icon + label for mobile overflow lists. */
  layout?: "icon" | "menu";
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

  if (props.layout === "menu") {
    return (
      <button
        aria-label={label}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-sm font-semibold text-dashboard-text transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!props.getMarkdown || status === "copying"}
        onClick={() => void copyMarkdown()}
        type="button"
      >
        <Icon aria-hidden="true" size={16} strokeWidth={2} />
        <span>{label}</span>
      </button>
    );
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
