import { useState } from "react";
import { Check, Share2 } from "lucide-react";

import { Button } from "../components/Button";
import { conversationPath } from "./conversationRoutes";

/** Copy a conversation link without changing who can access it. */
export function ShareConversationButton(props: {
  conversationId: string;
  layout?: "button" | "menu";
}) {
  const [status, setStatus] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");
  const label =
    status === "copied"
      ? "Link copied"
      : status === "failed"
        ? "Copy failed — retry"
        : "Share";
  const Icon = status === "copied" ? Check : Share2;
  const feedback =
    status === "copied"
      ? "Conversation link copied. Access has not changed."
      : status === "failed"
        ? "Could not copy the link. Try again or copy it from the address bar."
        : "";

  async function copyLink() {
    setStatus("copying");
    try {
      const url = new URL(
        conversationPath(props.conversationId),
        window.location.origin,
      );
      await navigator.clipboard.writeText(url.href);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  const content = (
    <>
      <Icon aria-hidden="true" size={16} strokeWidth={2} />
      <span>{label}</span>
    </>
  );
  const button =
    props.layout === "menu" ? (
      <button
        aria-label={label}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-sm font-semibold text-dashboard-text transition-colors hover:bg-dashboard-fill-hover focus-visible:bg-dashboard-fill-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        disabled={status === "copying"}
        onClick={() => void copyLink()}
        type="button"
      >
        {content}
      </button>
    ) : (
      <Button
        aria-label={label}
        disabled={status === "copying"}
        onClick={() => void copyLink()}
      >
        {content}
      </Button>
    );

  return (
    <>
      {button}
      <span className="sr-only" role="status">
        {feedback}
      </span>
    </>
  );
}
