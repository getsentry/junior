import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $getRoot,
  $getSelection,
  $setSelection,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_NORMAL,
  DROP_COMMAND,
  HISTORIC_TAG,
  BLUR_COMMAND,
  COMMAND_PRIORITY_LOW,
  FOCUS_COMMAND,
  KEY_ENTER_COMMAND,
  mergeRegister,
  PASTE_COMMAND,
  RootNode,
  SKIP_SCROLL_INTO_VIEW_TAG,
} from "lexical";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type Ref,
} from "react";

import { cn } from "../../styles";
import { ComposerHashMenu } from "../ComposerHashMenu";
import type { ComposerInsertion } from "../ComposerMenu";
import { ComposerMentionMenu } from "../ComposerMentionMenu";
import { ComposerSkillMenu } from "../ComposerSkillMenu";
import { mentionTokenAt } from "../composerMentionToken";
import { hashTokenAt } from "../composerReferences";
import { skillTokenAt } from "../skillReferences";
import { ComposerMarkerNode } from "./ComposerMarkerNode";
import { ComposerMentionNode } from "./ComposerMentionNode";
import { ComposerReferenceNode } from "./ComposerReferenceNode";
import {
  $readComposerText,
  $writeComposerText,
  type ComposerLookup,
} from "./composerEditorText";
import {
  $styleComposerDraft,
  placeCaretOutsideHiddenMarkers,
  syncComposerMarkers,
} from "./composerLiveMarkdown";
import { useLexicalTypeahead } from "./useLexicalTypeahead";
import { useSkillReferenceHighlights } from "./useSkillReferenceHighlights";

/** Imperative actions on the draft editor. */
export type ComposerEditorHandle = {
  /** Put the cursor in the draft, where it was, or at the end. */
  focus(): void;
  /**
   * Replace the draft. With `caretAtEnd`, put the cursor after the text and
   * scroll it into view. Undo starts again from the new text.
   */
  setText(text: string, options?: { caretAtEnd?: boolean }): void;
};

type ComposerEditorProps = {
  autocorrect: boolean;
  className: string;
  editable: boolean;
  /** The content editable element, for gestures of the composer. */
  elementRef: Ref<HTMLDivElement>;
  enterKeyHint: "enter" | "send";
  enterSends: boolean;
  label: string;
  lookup: ComposerLookup;
  maxLength: number;
  onChange(text: string): void;
  onEnter(): void;
  onFocus?: (() => void) | undefined;
  /** A person or reference that a menu put in. */
  onChip(insertion: Exclude<ComposerInsertion, { text: string }>): void;
  /** Files from a paste. Without it, a paste of files adds nothing. */
  onPasteFiles?: ((files: File[]) => void) | undefined;
  placeholder: string;
  /** Padding and type of the editor, which the placeholder also uses. */
  placeholderClassName: string;
  /**
   * The latest draft text. The editor reads it when it mounts, so text
   * typed in the stand-in text box while the editor loaded stays.
   */
  readText(): string;
  ref: Ref<ComposerEditorHandle>;
  /**
   * True when the stand-in text box has focus. The editor reads it as it
   * renders, before the stand-in goes, and then takes the focus.
   */
  standInFocused(): boolean;
};

/**
 * The composer's draft editor: plain text with inline mentions, reference
 * chips, and styled skill references, built on Lexical. The `$`, `@`, and
 * `#` menus run inside it. The composer lazy-loads this module, because
 * Lexical is large.
 */
export default function ComposerEditor(props: ComposerEditorProps) {
  const initialText = useRef(props.readText());
  const takeFocus = useRef(props.standInFocused());
  const { lookup } = props;
  return (
    <LexicalComposer
      initialConfig={{
        editable: props.editable,
        editorState: () => {
          $writeComposerText(initialText.current);
          $styleComposerDraft(lookup);
        },
        namespace: "junior-composer",
        nodes: [ComposerMarkerNode, ComposerMentionNode, ComposerReferenceNode],
        onError: (error) => {
          throw error;
        },
        theme: COMPOSER_THEME,
      }}
    >
      <div className="relative min-w-0">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              aria-autocomplete="list"
              aria-disabled={props.editable ? undefined : true}
              aria-label={props.label}
              aria-multiline
              aria-placeholder={props.placeholder}
              // Chat is technical: ids, paths, code. Browser assists fight
              // identifiers, unless the user turns autocorrect on.
              autoCapitalize={props.autocorrect ? "sentences" : "off"}
              autoComplete={props.autocorrect ? undefined : "off"}
              autoCorrect={props.autocorrect ? "on" : "off"}
              className={cn(props.className, props.placeholderClassName)}
              enterKeyHint={props.enterKeyHint}
              inputMode="text"
              onFocus={props.onFocus}
              placeholder={
                <div
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute inset-x-0 top-0 truncate select-none",
                    props.placeholderClassName,
                    "text-dashboard-text-faint",
                  )}
                >
                  {props.placeholder}
                </div>
              }
              ref={props.elementRef}
              spellCheck={props.autocorrect}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <ComposerBehavior
        {...props}
        initialText={initialText.current}
        takeFocus={takeFocus.current}
      />
    </LexicalComposer>
  );
}

function ComposerBehavior(
  props: ComposerEditorProps & { initialText: string; takeFocus: boolean },
) {
  const [editor] = useLexicalComposerContext();
  const callbacks = useRef(props);
  callbacks.current = props;
  const skill = useLexicalTypeahead(editor, skillTokenAt);
  const onChip = (insertion: ComposerInsertion) => {
    if (!("text" in insertion)) callbacks.current.onChip(insertion);
  };
  const mention = useLexicalTypeahead(editor, mentionTokenAt, onChip);
  const hash = useLexicalTypeahead(editor, hashTokenAt, onChip);
  useSkillReferenceHighlights(editor);

  // A selection in a content editable focuses it, so set one only to
  // focus. The composer scrolls itself, like a textarea with
  // `preventScroll`.
  const setText = (text: string, caretAtEnd: boolean) => {
    editor.update(
      () => {
        $writeComposerText(text);
        if (caretAtEnd) $getRoot().selectEnd();
        else $setSelection(null);
      },
      { discrete: true, tag: [HISTORIC_TAG, SKIP_SCROLL_INTO_VIEW_TAG] },
    );
    // A textarea forgets its undo steps when its value is set.
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  };
  // Put the caret back where it was, or at the end.
  const focus = (atEnd = false) => {
    const root = editor.getRootElement();
    if (!root) return;
    root.focus({ preventScroll: true });
    editor.update(
      () => {
        const selection = $getSelection();
        if (selection && !atEnd) $setSelection(selection.clone());
        else $getRoot().selectEnd();
      },
      { discrete: true, tag: SKIP_SCROLL_INTO_VIEW_TAG },
    );
  };

  useImperativeHandle(props.ref, () => ({
    focus: () => focus(),
    setText: (text, options) => {
      setText(text, Boolean(options?.caretAtEnd));
      if (!options?.caretAtEnd) return;
      const root = editor.getRootElement();
      root?.focus({ preventScroll: true });
      if (root) root.scrollTop = root.scrollHeight;
    },
  }));

  // Keep what the stand-in got while this module loaded.
  useLayoutEffect(() => {
    const latest = callbacks.current.readText();
    if (latest !== props.initialText) setText(latest, false);
    // The reader was typing in the stand-in, so carry on after the text.
    if (callbacks.current.takeFocus) focus(true);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Mount only.
  }, []);

  useEffect(() => editor.setEditable(props.editable), [editor, props.editable]);

  useEffect(
    () =>
      mergeRegister(
        editor.registerUpdateListener(
          ({ dirtyElements, dirtyLeaves, editorState, prevEditorState }) => {
            if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
            const text = editorState.read($readComposerText);
            // A textarea refuses text past its limit. Refuse the change.
            if (text.length > callbacks.current.maxLength) {
              editor.setEditorState(prevEditorState, { tag: HISTORIC_TAG });
              return;
            }
            callbacks.current.onChange(text);
          },
        ),
        // Last in each update: style the Markdown of the draft, and turn
        // pasted or restored `<@U…>` and reference tokens into chips. Not
        // while an input method composes, which a new node would break.
        editor.registerNodeTransform(RootNode, () => {
          if (!editor.isComposing()) {
            $styleComposerDraft(callbacks.current.lookup);
          }
        }),
        // Reveal the markers at the caret, after the caret leaves any
        // that are hidden.
        editor.registerUpdateListener(() => {
          placeCaretOutsideHiddenMarkers(editor);
          syncComposerMarkers(editor);
        }),
        editor.registerCommand(
          FOCUS_COMMAND,
          () => {
            syncComposerMarkers(editor);
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(
          BLUR_COMMAND,
          () => {
            // Focus moves after the blur event.
            requestAnimationFrame(() => syncComposerMarkers(editor));
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        // Below the menus, which take Enter while they are open.
        editor.registerCommand(
          KEY_ENTER_COMMAND,
          (event) => {
            if (
              !callbacks.current.enterSends ||
              !event ||
              event.shiftKey ||
              event.isComposing
            ) {
              return false;
            }
            event.preventDefault();
            callbacks.current.onEnter();
            return true;
          },
          COMMAND_PRIORITY_NORMAL,
        ),
        editor.registerCommand(
          PASTE_COMMAND,
          (event) => {
            const onPasteFiles = callbacks.current.onPasteFiles;
            const files =
              event instanceof ClipboardEvent
                ? Array.from(event.clipboardData?.files ?? [])
                : [];
            if (!onPasteFiles || !files.length) return false;
            event.preventDefault();
            onPasteFiles(files);
            return true;
          },
          COMMAND_PRIORITY_HIGH,
        ),
        // The composer form takes dropped files. Keep the editor from
        // inserting their names.
        editor.registerCommand(
          DROP_COMMAND,
          (event) => Boolean(event.dataTransfer?.types.includes("Files")),
          COMMAND_PRIORITY_HIGH,
        ),
      ),
    [editor],
  );

  return (
    <>
      <ComposerSkillMenu typeahead={skill} />
      <ComposerMentionMenu typeahead={mention} />
      <ComposerHashMenu typeahead={hash} />
    </>
  );
}

// Rendered Markdown, close to how the transcript shows it. Links underline,
// because Markdown links are the only underlined text.
const COMPOSER_THEME = {
  paragraph: "m-0",
  text: {
    bold: "font-semibold",
    code: "rounded-[0.25rem] bg-dashboard-fill-strong px-1 py-0.5 font-mono text-[0.9em]",
    italic: "italic",
    strikethrough: "line-through",
    underline: "text-dashboard-accent-text underline underline-offset-2",
  },
};
