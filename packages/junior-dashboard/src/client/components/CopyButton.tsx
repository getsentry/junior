import { useState } from "react";
import { Check, CircleAlert, Copy } from "lucide-react";

import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Copy available text and show whether the clipboard write succeeded. */
export function CopyButton(props: {
  getText?: () => Promise<string> | string;
  label: string;
  copyingLabel?: string;
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
        ? (props.copyingLabel ?? "Copying")
        : status === "failed"
          ? "Copy failed"
          : props.label;
  const Icon = {
    copied: Check,
    copying: Copy,
    failed: CircleAlert,
    idle: Copy,
  }[status];

  async function copyText() {
    if (!props.getText) return;

    try {
      setStatus("copying");
      await navigator.clipboard.writeText(await props.getText());
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  if (props.layout === "menu") {
    return (
      <Button
        aria-label={label}
        disabled={!props.getText || status === "copying"}
        onClick={() => void copyText()}
        size="menu"
      >
        <Icon aria-hidden="true" size={16} strokeWidth={2} />
        <span>{label}</span>
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            focusableWhenDisabled
            aria-label={label}
            disabled={!props.getText || status === "copying"}
            onClick={() => void copyText()}
            size="icon"
          >
            <Icon
              aria-hidden="true"
              className={status === "failed" ? "text-rose-300" : undefined}
              size={15}
              strokeWidth={2}
            />
          </Button>
        }
      />
      <TooltipContent size="compact">{label}</TooltipContent>
    </Tooltip>
  );
}
