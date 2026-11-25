import { useRef, useState, type ReactNode } from "react";
import { CONVERSATION_TITLE_MAX_LENGTH } from "@sentry/junior/api/schema";

import { MobileHeaderTitlePortal } from "../components/layout/DashboardChrome";
import { Input } from "../components/ui/input";
import { cn } from "../styles";

// Browsers reset controls to `text-rendering: auto`, which spaces glyphs
// unlike the page's `geometricPrecision`, so the title would change width.
const titleTextRendering = "[text-rendering:inherit]";

/** The title edit that a Conversation header shares with its page. */
export type ConversationTitleEdit = {
  editing: boolean;
  onEditingChange(editing: boolean): void;
  onSave(title: string): void;
};

/**
 * Show a Conversation title, or a text field while `editing` is set. The
 * title itself is not a control: Rename in the Conversation menu sets
 * `editing`. Enter or leaving the field saves a changed title. Escape
 * cancels. The header can show it twice, for desktop and for phones; only
 * the visible copy takes focus.
 */
export function EditableConversationTitle(
  props: ConversationTitleEdit & {
    /** The title as it shows when not editing, such as fading text. */
    children: ReactNode;
    /** Font classes. The field uses them too, so the text does not move. */
    className: string;
    title: string;
  },
) {
  if (!props.editing) return props.children;
  return (
    <TitleField
      className={props.className}
      onDone={(title) => {
        if (title !== undefined) props.onSave(title);
        props.onEditingChange(false);
      }}
      title={props.title}
    />
  );
}

/** Put the editable title in the app bar, which shows the title on a phone. */
export function MobileEditableConversationTitle(
  props: ConversationTitleEdit & { children: ReactNode; title: string },
) {
  return (
    <MobileHeaderTitlePortal>
      <h1 className="m-0 flex min-w-0 flex-1 text-dashboard-text">
        <EditableConversationTitle
          {...props}
          className="font-display text-sm font-medium"
        />
      </h1>
    </MobileHeaderTitlePortal>
  );
}

function TitleField(props: {
  className: string;
  /** `title` is unset when nothing should save. */
  onDone(title: string | undefined): void;
  title: string;
}) {
  const [draft, setDraft] = useState(props.title);
  const done = useRef(false);
  const finish = (save: boolean) => {
    // Unmounting the field after Enter or Escape can blur it once more.
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    const changed = save && next.length > 0 && next !== props.title;
    props.onDone(changed ? next : undefined);
  };
  return (
    <form
      className="-mx-1.5 min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        finish(true);
      }}
    >
      <Input
        aria-label="Conversation title"
        // The visible copy takes focus; a hidden one cannot.
        autoFocus
        className={cn(
          "-my-px px-1.25 py-0",
          titleTextRendering,
          // 16px on phones, so iOS does not zoom into the field.
          "max-md:text-base",
          props.className,
        )}
        enterKeyHint="done"
        maxLength={CONVERSATION_TITLE_MAX_LENGTH}
        onBlur={() => finish(true)}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // Escape cancels here, not in the page behind the field.
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }}
        value={draft}
      />
    </form>
  );
}
