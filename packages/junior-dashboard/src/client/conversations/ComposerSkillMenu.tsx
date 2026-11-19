import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

import type { SkillReport } from "@sentry/junior/api/schema";
import { useSkillsData } from "../api";
import { MatchedLabel } from "../components/MatchedLabel";
import { searchSkills, type SkillSearchRow } from "../components/skillSearch";
import { SkillDrawer, skillLabel, skillSource } from "../components/SkillLink";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { isPlatformShortcut, platformShortcut } from "../keyboard";
import { cn } from "../styles";
import { skillTokenAt, type SkillToken } from "./composerSkillToken";

/**
 * Suggest skills while the reader types `$` in the composer. Focus stays in
 * the textarea: arrows move, Enter or Tab inserts `$skill-name`, Ctrl or
 * Cmd I opens its SKILL.md, Escape closes. `onInsert` gets the new draft text.
 *
 * A card describes the installed skill that the caret moves into, and the
 * skill that was just inserted. Typing shows the menu, and a caret move into
 * a complete installed `$name` shows the card, so the two never show
 * together. Pass `edit` to `onChange` and `sync` to `onSelect`.
 */
export function useComposerSkillMenu(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  onInsert: (text: string) => void,
) {
  const gridId = useId();
  const detailsId = useId();
  const cardId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState<SkillToken>();
  const [placement, setPlacement] = useState<MenuPlacement>();
  const [activeIndex, setActiveIndex] = useState(0);
  // A row becomes active after the pointer rests on it. Each move restarts
  // the wait, so a diagonal move to the details pane keeps the row.
  const hoverTimer = useRef<number>(undefined);
  const cancelHover = () => window.clearTimeout(hoverTimer.current);
  // Escape closes the menu until the caret leaves that reference.
  const [dismissedStart, setDismissedStart] = useState<number>();
  // Fetch the skill list on the first `$`, not on every composer mount.
  const [wanted, setWanted] = useState(false);
  const skills = useSkillsData({ enabled: wanted }).data;
  // The skill whose SKILL.md drawer is open. The menu stays open under it.
  const [viewing, setViewing] = useState<string>();
  // The row that shows its description below it on narrow screens.
  const [expanded, setExpanded] = useState<string>();
  // The reference that the card describes. `start` is the index of its `$`.
  const [card, setCard] = useState<{ name: string; start: number }>();
  // The text and caret of the last sync. `onSelect` also fires after an
  // edit and after an insert, and that must not turn the menu into a card.
  const synced = useRef<{ text: string; caret: number }>(undefined);
  // A send clears the text without an edit event, so check that the
  // reference is still there.
  const cardSkill =
    card && textareaRef.current?.value.startsWith(`$${card.name}`, card.start)
      ? skills?.find((skill) => skill.name === card.name)
      : undefined;
  const rows =
    token && skills && !cardSkill ? skillRows(skills, token.query) : [];
  const open = rows.length > 0;
  const shown = open || Boolean(cardSkill);
  const active = Math.min(activeIndex, rows.length - 1);
  const cellId = (index: number) => `${gridId}-${index}`;

  // The composer moves with the layout, so follow it while the menu is open.
  useEffect(() => {
    if (!shown) return;
    const place = () => {
      if (textareaRef.current) setPlacement(menuPlacement(textareaRef.current));
    };
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [shown, textareaRef]);

  const activeCell = open ? cellId(active) : undefined;
  useEffect(() => {
    if (activeCell) {
      document.getElementById(activeCell)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeCell, token?.query]);

  // Show an expanded row down to its View full skill button. It runs after
  // the active row scroll, so a long description does not hide the button.
  const expandedPanel = expanded
    ? `${cellId(rows.findIndex((row) => row.skill.name === expanded))}-panel`
    : undefined;
  useEffect(() => {
    if (!expandedPanel) return;
    document
      .getElementById(expandedPanel)
      ?.querySelector("button")
      ?.scrollIntoView({ block: "nearest" });
  }, [expandedPanel]);

  const close = () => {
    cancelHover();
    setToken(undefined);
    setCard(undefined);
  };
  // A tap on the menu blurs the textarea before its click lands, and a
  // scrollbar drag blurs it too. Keep the menu open while a press in it
  // runs. Mobile browsers fire the blur after `pointerup`, so the click
  // ends the press. A drag or scroll ends with no click, so the next
  // press outside the menu also ends it.
  const pressingMenu = useRef(false);

  useEffect(() => {
    if (!shown) return;
    const endPress = (event: PointerEvent) => {
      const menu = menuRef.current;
      if (!(event.target instanceof Node) || !menu?.contains(event.target)) {
        pressingMenu.current = false;
      }
    };
    document.addEventListener("pointerdown", endPress, true);
    return () => document.removeEventListener("pointerdown", endPress, true);
  }, [shown]);

  /**
   * Close on blur, unless the blur comes from a press in the menu or from
   * the SKILL.md drawer taking focus.
   */
  const blur = () => {
    if (pressingMenu.current || viewing) return;
    close();
    // A click back in at the same caret reopens it.
    synced.current = undefined;
  };

  /** Open a SKILL.md from a press on a View full skill button. */
  const view = (name: string) => {
    pressingMenu.current = false;
    setViewing(name);
  };

  /** Return to the textarea, which kept its caret while the drawer was open. */
  const closeDrawer = () => {
    setViewing(undefined);
    textareaRef.current?.focus({ preventScroll: true });
  };

  /** Read the reference at the caret after an edit or caret move. */
  const sync = (edited = false) => {
    const textarea = textareaRef.current;
    if (!textarea || textarea.selectionStart !== textarea.selectionEnd) {
      close();
      // A collapse back to the same caret reopens it.
      synced.current = undefined;
      return;
    }
    const text = textarea.value;
    const caret = textarea.selectionStart;
    if (
      !edited &&
      synced.current?.text === text &&
      synced.current.caret === caret
    ) {
      return;
    }
    synced.current = { text, caret };
    const next = skillTokenAt(text, caret);
    if (next?.start !== dismissedStart) setDismissedStart(undefined);
    if (!next || next.start === dismissedStart) {
      close();
      return;
    }
    setWanted(true);
    setPlacement(menuPlacement(textarea));
    const name = text.slice(next.start + 1, next.end);
    if (!edited && skills?.some((skill) => skill.name === name)) {
      setToken(undefined);
      setCard({ name, start: next.start });
      return;
    }
    // Before the skill list loads, a caret move can still be into an
    // installed skill. Keep both, and the card wins if the name resolves.
    setCard(!edited && !skills ? { name, start: next.start } : undefined);
    if (next.query !== token?.query || next.start !== token.start) {
      setActiveIndex(0);
    }
    setToken(next);
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
    // Describe the new reference until the next edit or caret move.
    setCard({ name, start: token.start });
    synced.current = { text: textarea.value, caret: textarea.selectionStart };
    onInsert(textarea.value);
  };

  /** Handle menu keys. Returns true when the key belonged to the menu. */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return false;
    if (!open) return cardKeyDown(event);
    const move = (delta: number) => {
      cancelHover();
      setActiveIndex((active + delta + rows.length) % rows.length);
    };
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
        // Not ArrowRight, because it moves the caret.
        if (!isPlatformShortcut(event.nativeEvent, "i")) return false;
        setViewing(rows[active]!.skill.name);
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  /** Escape closes the card, and Ctrl or Cmd I opens its SKILL.md. */
  const cardKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!card || !cardSkill) return false;
    if (event.key === "Escape") {
      setDismissedStart(card.start);
      setCard(undefined);
    } else if (isPlatformShortcut(event.nativeEvent, "i")) {
      setViewing(cardSkill.name);
    } else {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  // A textbox supports these. `aria-expanded` needs the combobox role.
  const textboxProps = {
    "aria-activedescendant": open ? cellId(active) : undefined,
    "aria-autocomplete": "list" as const,
    "aria-controls": open ? gridId : undefined,
    "aria-describedby": cardSkill
      ? `${cardId}-source ${cardId}-description`
      : undefined,
  };

  // Shared by the menu and the card, which take the same place.
  const popupProps = {
    ref: menuRef,
    style: placement,
    // Keep focus and the caret in the textarea on desktop.
    onMouseDown: (event: MouseEvent) => event.preventDefault(),
    onPointerDown: () => {
      pressingMenu.current = true;
    },
    onPointerCancel: () => {
      pressingMenu.current = false;
    },
    // A tap moved focus out of the textarea. Put it back.
    onClick: () => {
      pressingMenu.current = false;
      textareaRef.current?.focus({ preventScroll: true });
    },
  };

  // A portal, because docks around the composer clip their overflow.
  const menu = (
    <>
      {open && placement
        ? createPortal(
            // At `@lg` (32rem) the menu puts a fixed-width list beside the
            // details pane. Narrower, rows expand in place.
            <div
              className="@container fixed z-50 flex overflow-hidden rounded-lg border border-input bg-secondary shadow-lg"
              {...popupProps}
            >
              {/* A grid, not a listbox: narrow rows hold real buttons. */}
              <div
                aria-label="Skills"
                className="thin-scrollbar min-w-0 flex-1 overflow-y-auto overscroll-contain p-1.5 @lg:w-56 @lg:flex-none"
                id={gridId}
                onMouseLeave={cancelHover}
                role="grid"
              >
                {rows.map((row, index) => (
                  <SkillRow
                    active={index === active}
                    describedBy={
                      index === active
                        ? `${detailsId}-source ${detailsId}-description ${detailsId}-keys`
                        : undefined
                    }
                    expanded={expanded === row.skill.name}
                    id={cellId(index)}
                    key={row.skill.name}
                    onHover={() => {
                      cancelHover();
                      if (index === active) return;
                      hoverTimer.current = window.setTimeout(
                        () => setActiveIndex(index),
                        HOVER_DWELL_MS,
                      );
                    }}
                    onSelect={() => insert(row.skill.name)}
                    onToggle={() => {
                      cancelHover();
                      setActiveIndex(index);
                      setExpanded((name) =>
                        name === row.skill.name ? undefined : row.skill.name,
                      );
                    }}
                    onView={() => view(row.skill.name)}
                    row={row}
                  />
                ))}
              </div>
              <div className="hidden min-w-0 flex-1 flex-col border-l border-input p-3 @lg:flex">
                <SkillDetails
                  id={detailsId}
                  onView={() => view(rows[active]!.skill.name)}
                  skill={rows[active]!.skill}
                >
                  <div
                    className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-dashboard-text-muted"
                    id={`${detailsId}-keys`}
                  >
                    <Kbd>Enter</Kbd> insert · <Kbd>{platformShortcut("i")}</Kbd>{" "}
                    view SKILL.md · <Kbd>Esc</Kbd> close
                  </div>
                </SkillDetails>
              </div>
            </div>,
            document.body,
          )
        : null}
      {!open && cardSkill && placement
        ? createPortal(
            <div
              aria-label={skillLabel(cardSkill.name)}
              className="fixed z-50 flex max-w-md flex-col overflow-hidden rounded-lg border border-input bg-secondary p-3 shadow-lg"
              role="group"
              {...popupProps}
            >
              <SkillDetails
                id={cardId}
                onView={() => view(cardSkill.name)}
                skill={cardSkill}
              />
            </div>,
            document.body,
          )
        : null}
      {viewing ? <SkillDrawer name={viewing} onClose={closeDrawer} /> : null}
    </>
  );

  return {
    blur,
    edit: () => sync(true),
    textboxProps,
    handleKeyDown,
    menu,
    sync: () => sync(),
  };
}

type MenuPlacement = {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

const HOVER_DWELL_MS = 120;

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

function SkillRow(props: {
  active: boolean;
  describedBy?: string;
  expanded: boolean;
  id: string;
  row: SkillSearchRow;
  onHover(): void;
  onSelect(): void;
  onToggle(): void;
  onView(): void;
}) {
  const { skill } = props.row;
  const panelId = `${props.id}-panel`;
  return (
    <>
      <div
        className={cn(
          "flex items-center rounded-md font-sans text-sm text-foreground select-none",
          props.active && "bg-dashboard-fill-hover",
        )}
        onMouseMove={props.onHover}
        role="row"
      >
        <div
          aria-describedby={props.describedBy}
          aria-selected={props.active}
          className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-3 px-2.5 @lg:min-h-0 @lg:py-1.5"
          id={props.id}
          onClick={props.onSelect}
          role="gridcell"
        >
          <span className="truncate font-mono">
            $
            <MatchedLabel label={skill.name} matches={props.row.nameMatches} />
          </span>
          {skill.disableModelInvocation ? <ManualOnlyBadge /> : null}
        </div>
        {/* The details pane takes this role on wide screens. */}
        <div className="@lg:hidden" role="gridcell">
          <button
            aria-controls={panelId}
            aria-expanded={props.expanded}
            aria-label={`Details for ${skillLabel(skill.name)}`}
            className="flex size-10 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-dashboard-text-muted"
            onClick={props.onToggle}
            type="button"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-4 transition-transform",
                props.expanded && "rotate-180",
              )}
            />
          </button>
        </div>
      </div>
      {props.expanded ? (
        <div className="px-2.5 pt-1 pb-2.5 @lg:hidden" id={panelId} role="row">
          <div className="grid gap-2.5" role="gridcell">
            <p className="m-0 text-sm [overflow-wrap:anywhere] text-dashboard-text-muted">
              {skill.description}
            </p>
            <ViewSkillButton className="w-full" onView={props.onView} />
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Describe one skill: name, source, the full description, and a way in. A
 * long description scrolls, so View full skill stays in sight.
 */
function SkillDetails(props: {
  children?: ReactNode;
  id: string;
  skill: SkillReport;
  onView(): void;
}) {
  const { skill } = props;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 font-sans">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold [overflow-wrap:anywhere] text-foreground">
          {skillLabel(skill.name)}
        </span>
        {skill.disableModelInvocation ? <ManualOnlyBadge /> : null}
      </div>
      <div
        className="text-xs text-dashboard-text-muted"
        id={`${props.id}-source`}
      >
        {skillSource(skill)}
      </div>
      <p
        className="thin-scrollbar m-0 mt-1 min-h-0 overflow-y-auto overscroll-contain text-sm [overflow-wrap:anywhere] text-foreground"
        id={`${props.id}-description`}
      >
        {skill.description}
      </p>
      <div className="mt-auto flex shrink-0 flex-wrap items-center justify-between gap-3 pt-3">
        <ViewSkillButton onView={props.onView} />
        {props.children}
      </div>
    </div>
  );
}

function ViewSkillButton(props: { className?: string; onView(): void }) {
  return (
    <Button
      className={props.className}
      onClick={(event) => {
        // The menu's own click puts focus back in the textarea. The drawer
        // takes focus instead.
        event.stopPropagation();
        props.onView();
      }}
      variant="outline"
    >
      View full skill
    </Button>
  );
}

function ManualOnlyBadge() {
  return (
    <Badge
      className="shrink-0 py-0.5 leading-none font-medium"
      variant="accent"
    >
      Manual only
    </Badge>
  );
}
