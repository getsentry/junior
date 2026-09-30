import type { InputImage } from "@sentry/junior/api/schema";
import { Globe2, LockKeyhole } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ToggleButton } from "../components/Button";
import { ConversationComposer } from "./ConversationComposer";

/**
 * Start a new root Conversation with a public or private toggle. The home
 * page and a Space page both use it.
 */
export function NewConversationView(props: {
  error?: string;
  /** Heading above the composer. */
  heading?: string;
  /** Extra line under the heading, such as the target Space. */
  subheading?: ReactNode;
  onSubmit(
    message: string,
    idempotencyKey: string,
    visibility: "private" | "public",
    images?: InputImage[],
  ): Promise<void>;
}) {
  const [visibility, setVisibility] = useState<"private" | "public">("public");
  const isPublic = visibility === "public";

  return (
    <section
      aria-label="New conversation"
      className="mx-auto grid w-full max-w-3xl gap-3"
    >
      <h2 className="m-0 text-center font-display text-2xl font-medium tracking-[-0.03em] text-dashboard-text md:text-3xl">
        {props.heading ?? "What do you need?"}
      </h2>
      {props.subheading ? (
        <div className="-mt-1 flex justify-center">{props.subheading}</div>
      ) : null}
      <ConversationComposer
        draftId="new"
        error={props.error}
        footerStart={
          <div
            aria-label="Conversation visibility"
            className="inline-flex items-center gap-1"
            role="group"
          >
            <ToggleButton
              onClick={() => setVisibility("public")}
              pressed={isPublic}
              type="button"
              variant="segment"
            >
              <Globe2 aria-hidden="true" className="mr-1 inline size-3" />
              Public
            </ToggleButton>
            <ToggleButton
              onClick={() => setVisibility("private")}
              pressed={!isPublic}
              type="button"
              variant="segment"
            >
              <LockKeyhole aria-hidden="true" className="mr-1 inline size-3" />
              Private
            </ToggleButton>
          </div>
        }
        label="Start a conversation"
        restoreDraftOnError
        submitLabel="Send"
        onSubmit={(message, idempotencyKey, images) =>
          props.onSubmit(message, idempotencyKey, visibility, images)
        }
      />
    </section>
  );
}
