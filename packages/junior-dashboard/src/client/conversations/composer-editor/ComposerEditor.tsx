import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import {
  $getRoot,
  $getSelection,
  $setSelection,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_NORMAL,
  DROP_COMMAND,
  HISTORIC_TAG,
  INSERT_PARAGRAPH_COMMAND,
  $isRangeSelection,
  KEY_ENTER_COMMAND,
  mergeRegister,
  PASTE_COMMAND,
  SKIP_SCROLL_INTO_VIEW_TAG,
  TextNode,
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
import { skillTokenAt } from "../composerSkillToken";
import { ComposerMentionNode } from "./ComposerMentionNode";
import { ComposerReferenceNode } from "./ComposerReferenceNode";
import {
  $insertComposerMarkdown,
  $readComposerText,
  $replaceComposerTokens,
  $writeComposerText,
  type ComposerLookup,
} from "./composerEditorText";
import {
  $isInMultilineBlock,
  COMPOSER_MARKDOWN,
  COMPOSER_MARKDOWN_NODES,
  COMPOSER_THEME,
} from "./composerMarkdown";
import { useLexicalTypeahead } from "./useLexicalTypeahead";

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
 * The composer's draft editor: Markdown that renders as you type, with
 * inline mentions and reference chips, built on Lexical. The draft text
 * stays Markdown. The `$`, `@`, and `#` menus run inside it. The composer
 * lazy-loads this module, because Lexical is large.
 */
export default function ComposerEditor(props: ComposerEditorProps) {
  const initialText = useRef(props.readText());
  const takeFocus = useRef(props.standInFocused());
  const { lookup } = props;
  return (
    <LexicalComposer
      initialConfig={{
        editable: props.editable,
        editorState: () => $writeComposerText(initialText.current, lookup),
        namespace: "junior-composer",
        nodes: [
          ComposerMentionNode,
          ComposerReferenceNode,
          ...COMPOSER_MARKDOWN_NODES,
        ],
        onError: (error) => {
          throw error;
        },
        theme: COMPOSER_THEME,
      }}
    >
      <div className="relative min-w-0">
        <RichTextPlugin
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
      <ListPlugin />
      <LinkPlugin />
      <MarkdownShortcutPlugin transformers={COMPOSER_MARKDOWN} />
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

  // A selection in a content editable focuses it, so set one only to
  // focus. The composer scrolls itself, like a textarea with
  // `preventScroll`.
  const setText = (text: string, caretAtEnd: boolean) => {
    editor.update(
      () => {
        $writeComposerText(text, callbacks.current.lookup);
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
        // Pasted or restored `<@U…>` and reference tokens become chips.
        editor.registerNodeTransform(TextNode, (node) =>
          $replaceComposerTokens(node, callbacks.current.lookup),
        ),
        // Below the menus, which take Enter while they are open.
        editor.registerCommand(
          KEY_ENTER_COMMAND,
          (event) => {
            if (!event || event.isComposing) return false;
            // Shift+Enter starts a new paragraph, not a line break, so a
            // Markdown block shortcut works on the new line. Enter adds a
            // line in a code block or a list.
            const newLine =
              event.shiftKey ||
              !callbacks.current.enterSends ||
              editor.getEditorState().read(() => {
                const selection = $getSelection();
                return (
                  $isRangeSelection(selection) &&
                  $isInMultilineBlock(selection.anchor.getNode())
                );
              });
            event.preventDefault();
            if (newLine) {
              editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
            } else {
              callbacks.current.onEnter();
            }
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
            if (onPasteFiles && files.length) {
              event.preventDefault();
              onPasteFiles(files);
              return true;
            }
            // Paste text as Markdown and render it, as if it was typed.
            // Formatting from a web page or another editor does not come in.
            const text =
              event instanceof ClipboardEvent
                ? event.clipboardData?.getData("text/plain")
                : undefined;
            if (!text) return false;
            event.preventDefault();
            editor.update(() => $insertComposerMarkdown(text));
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
