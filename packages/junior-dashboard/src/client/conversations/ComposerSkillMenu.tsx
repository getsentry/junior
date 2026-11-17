import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { SkillReport } from "@sentry/junior/api/schema";
import { useSkillsData } from "../api";
import { MatchedLabel } from "../components/MatchedLabel";
import { searchSkills, type SkillSearchRow } from "../components/skillSearch";
import { Badge } from "../components/ui/badge";
import { cn } from "../styles";
import { skillTokenAt, type SkillToken } from "./composerSkillToken";

/**
 * Suggest skills while the reader types `$` in the composer. Focus stays in
 * the textarea: arrows move, Enter or Tab inserts `$skill-name`, Escape
 * closes. `onInsert` gets the new draft text.
 */
export function useComposerSkillMenu(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  onInsert: (text: string) => void,
) {
  const listboxId = useId();
  const [token, setToken] = useState<SkillToken>();
  const [placement, setPlacement] = useState<MenuPlacement>();
  const [activeIndex, setActiveIndex] = useState(0);
  // Escape closes the menu until the caret leaves that reference.
  const [dismissedStart, setDismissedStart] = useState<number>();
  // Fetch the skill list on the first `$`, not on every composer mount.
  const [wanted, setWanted] = useState(false);
  const skills = useSkillsData({ enabled: wanted }).data;
  const rows = token && skills ? skillRows(skills, token.query) : [];
  const open = rows.length > 0;
  const active = Math.min(activeIndex, rows.length - 1);
  const optionId = (index: number) => `${listboxId}-${index}`;

  // The composer moves with the layout, so follow it while the menu is open.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      if (textareaRef.current) setPlacement(menuPlacement(textareaRef.current));
    };
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, textareaRef]);

  useEffect(() => {
    if (!open) return;
    document
      .getElementById(optionId(active))
      ?.scrollIntoView({ block: "nearest" });
  });

  const close = () => setToken(undefined);
  // A tap on the menu blurs the textarea before its click lands, and a
  // scrollbar drag blurs it too. Keep the menu open while a press in it
  // runs. Mobile browsers fire the blur after `pointerup`, so the click
  // ends the press.
  const pressingMenu = useRef(false);

  /** Close on blur, unless the blur comes from a press in the menu. */
  const blur = () => {
    if (!pressingMenu.current) close();
  };

  /** Read the reference at the caret after an edit or caret move. */
  const sync = () => {
    const textarea = textareaRef.current;
    if (!textarea || textarea.selectionStart !== textarea.selectionEnd) {
      close();
      return;
    }
    const next = skillTokenAt(textarea.value, textarea.selectionStart);
    if (next?.start !== dismissedStart) setDismissedStart(undefined);
    if (!next || next.start === dismissedStart) {
      close();
      return;
    }
    if (next.query !== token?.query || next.start !== token.start) {
      setActiveIndex(0);
    }
    setWanted(true);
    setToken(next);
    setPlacement(menuPlacement(textarea));
  };

  const insert = (name: string) => {
    const textarea = textareaRef.current;
    if (!textarea || !token) return;
    // Reuse a space that already follows the reference.
    const spaced = /^\s/.test(textarea.value.slice(token.end));
    textarea.setRangeText(
      `$${name}${spaced ? "" : " "}`,
      token.start,
      token.end,
      "end",
    );
    if (spaced) {
      textarea.setSelectionRange(
        textarea.selectionEnd + 1,
        textarea.selectionEnd + 1,
      );
    }
    close();
    onInsert(textarea.value);
  };

  /** Handle menu keys. Returns true when the key belonged to the menu. */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing) return false;
    const move = (delta: number) =>
      setActiveIndex((active + delta + rows.length) % rows.length);
    switch (event.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "Enter":
      case "Tab":
        if (event.shiftKey) return false;
        insert(rows[active]!.skill.name);
        break;
      case "Escape":
        setDismissedStart(token?.start);
        close();
        break;
      default:
        return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  // A textbox supports these. `aria-expanded` needs the combobox role.
  const textboxProps = {
    "aria-activedescendant": open ? optionId(active) : undefined,
    "aria-autocomplete": "list" as const,
    "aria-controls": open ? listboxId : undefined,
  };

  // A portal, because docks around the composer clip their overflow.
  const menu =
    open && placement
      ? createPortal(
          <div
            className="thin-scrollbar fixed z-50 overflow-y-auto overscroll-contain rounded-lg border border-input bg-secondary p-1.5 shadow-lg"
            id={listboxId}
            style={placement}
            role="listbox"
            aria-label="Skills"
            // Keep focus and the caret in the textarea on desktop.
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={() => {
              pressingMenu.current = true;
            }}
            onPointerCancel={() => {
              pressingMenu.current = false;
            }}
            // A tap moved focus out of the textarea. Put it back.
            onClick={() => {
              pressingMenu.current = false;
              textareaRef.current?.focus({ preventScroll: true });
            }}
          >
            {rows.map((row, index) => (
              <SkillOption
                active={index === active}
                id={optionId(index)}
                key={row.skill.name}
                onHover={() => setActiveIndex(index)}
                onSelect={() => insert(row.skill.name)}
                row={row}
              />
            ))}
          </div>,
          document.body,
        )
      : null;

  return { blur, textboxProps, handleKeyDown, menu, sync };
}

type MenuPlacement = {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

// In rem, converted with the root font size: the free space is in px.
const MENU_MAX_REM = 20;
const MENU_GAP_REM = 0.5;

/**
 * Open the menu on the side of the composer with more room, so the home
 * composer near the top of the page opens it downward.
 */
function menuPlacement(textarea: HTMLTextAreaElement): MenuPlacement {
  const rem = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  const composer = (textarea.form ?? textarea).getBoundingClientRect();
  const gap = MENU_GAP_REM * rem;
  const above = composer.top;
  const below = window.innerHeight - composer.bottom;
  return {
    left: composer.left,
    width: composer.width,
    maxHeight: Math.min(MENU_MAX_REM * rem, Math.max(above, below) - 2 * gap),
    ...(below > above
      ? { top: composer.bottom + gap }
      : { bottom: window.innerHeight - composer.top + gap }),
  };
}

function skillRows(
  skills: readonly SkillReport[],
  query: string,
): SkillSearchRow[] {
  // People type names after `$`, so a description match is noise here.
  if (query) {
    return searchSkills(skills, query).filter((row) => row.nameMatches);
  }
  return [...skills]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((skill) => ({ skill }));
}

function SkillOption(props: {
  active: boolean;
  id: string;
  row: SkillSearchRow;
  onHover(): void;
  onSelect(): void;
}) {
  const { skill } = props.row;
  return (
    <div
      aria-selected={props.active}
      className={cn(
        "flex cursor-pointer items-baseline gap-3 rounded-md px-2.5 py-1.5 font-sans text-sm text-foreground select-none",
        props.active && "bg-dashboard-fill-hover",
      )}
      id={props.id}
      onClick={props.onSelect}
      onMouseMove={props.active ? undefined : props.onHover}
      role="option"
    >
      <span className="shrink-0 font-mono">
        $
        <MatchedLabel label={skill.name} matches={props.row.nameMatches} />
      </span>
      {skill.disableModelInvocation ? (
        <Badge
          className="shrink-0 py-0.5 leading-none font-medium"
          variant="accent"
        >
          Manual only
        </Badge>
      ) : null}
      <span className="min-w-0 truncate text-xs text-dashboard-text-muted">
        {skill.description}
      </span>
    </div>
  );
}
