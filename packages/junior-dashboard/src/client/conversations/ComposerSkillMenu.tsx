import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
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
import { platformShortcut } from "../keyboard";
import { cn } from "../styles";
import {
  cardPlacement,
  composerRect,
  menuPlacement,
  type ComposerMenuKey,
  type ComposerTypeahead,
  type MenuPlacement,
} from "./ComposerMenu";

/**
 * Suggest skills while the reader types `$`. Focus stays in the text box:
 * arrows move, Enter or Tab inserts `$skill-name`, Ctrl or Cmd I opens its
 * SKILL.md, Escape closes.
 *
 * A card describes the installed skill that the caret moves into, and the
 * skill that was just inserted. Typing shows the menu, and a caret move into
 * a complete installed `$name` shows the card, so the two never show
 * together.
 */
export function ComposerSkillMenu(props: { typeahead: ComposerTypeahead }) {
  const { typeahead } = props;
  const { textbox } = typeahead;
  const gridId = useId();
  const detailsId = useId();
  const cardId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState<MenuPlacement>();
  // A row becomes active after the pointer rests on it. Each move restarts
  // the wait, so a diagonal move to the details pane keeps the row.
  const hoverTimer = useRef<number>(undefined);
  const cancelHover = () => window.clearTimeout(hoverTimer.current);
  // The skill whose SKILL.md drawer is open. The menu stays open under it.
  const [viewing, setViewing] = useState<string>();
  // The row that shows its description below it on narrow screens.
  const [expanded, setExpanded] = useState<string>();
  const inserted = typeahead.inserted?.startsWith("$")
    ? typeahead.inserted.slice(1)
    : undefined;
  // Fetch the skill list on the first `$`, not on every composer mount.
  const [wanted, setWanted] = useState(false);
  if (!wanted && (typeahead.query !== undefined || inserted)) setWanted(true);
  const skills = useSkillsData({ enabled: wanted }).data;
  // Before the skill list loads, a caret move can be into an installed
  // skill. The card shows once its name resolves.
  const cardName = inserted ?? (typeahead.edited ? undefined : typeahead.name);
  const cardSkill = cardName
    ? skills?.find((skill) => skill.name === cardName)
    : undefined;
  const rows =
    typeahead.query !== undefined && skills && !cardSkill
      ? skillRows(skills, typeahead.query)
      : [];
  const open = rows.length > 0;
  const shown = open || Boolean(cardSkill);
  const active = Math.min(activeIndex, rows.length - 1);
  const cellId = (index: number) => `${gridId}-${index}`;

  // A new query starts at the first row.
  const [lastQuery, setLastQuery] = useState(typeahead.query);
  if (lastQuery !== typeahead.query) {
    setLastQuery(typeahead.query);
    setActiveIndex(0);
  }

  // The menu sits beside the composer, which it needs the width of. The
  // card sits on its reference, and follows it when the box or the page
  // scrolls. Both follow the layout. Place before paint, so a card that
  // replaces the menu never shows in the menu's spot first.
  const { referenceRect } = typeahead;
  useLayoutEffect(() => {
    if (!shown || !textbox) return;
    const place = () => {
      const reference = open ? undefined : referenceRect();
      setPlacement(
        reference
          ? cardPlacement(composerRect(textbox), reference)
          : menuPlacement(textbox),
      );
    };
    place();
    window.addEventListener("resize", place);
    if (!open) window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, shown, textbox, referenceRect, typeahead.query, cardSkill]);

  const activeCell = open ? cellId(active) : undefined;
  useEffect(() => {
    if (activeCell) {
      document.getElementById(activeCell)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeCell, typeahead.query]);

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

  // A tap or a scrollbar drag in a popup blurs the text box, and the
  // SKILL.md drawer takes focus. Keep the popup open through both. Mobile
  // browsers fire the blur after `pointerup`, so the click ends the press.
  // A drag or a scroll ends with no click, so the next press outside the
  // popup also ends it.
  const pressing = useRef(false);
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  const hold = (press: boolean) => {
    pressing.current = press;
    typeahead.holdOpen(press || Boolean(viewingRef.current));
  };
  useEffect(() => {
    if (!shown) return;
    const endPress = (event: PointerEvent) => {
      const menu = menuRef.current;
      if (!(event.target instanceof Node) || !menu?.contains(event.target)) {
        hold(false);
      }
    };
    document.addEventListener("pointerdown", endPress, true);
    return () => document.removeEventListener("pointerdown", endPress, true);
  });

  /** Open a SKILL.md. The drawer takes focus, so hold the popup first. */
  const view = (name: string) => {
    viewingRef.current = name;
    hold(false);
    setViewing(name);
  };

  /** Return to the text box, which kept its caret while the drawer was open. */
  const closeDrawer = () => {
    viewingRef.current = undefined;
    hold(false);
    setViewing(undefined);
    typeahead.focus();
  };

  const insert = (name: string) => {
    cancelHover();
    typeahead.insert({ text: `$${name}` });
  };

  useEffect(() => {
    if (!shown) return;
    return typeahead.registerKeys((key) => {
      if (!open) {
        // Escape closes the card, and Ctrl or Cmd I opens its SKILL.md.
        if (key === "close") typeahead.dismiss();
        else if (key === "view" && cardSkill) view(cardSkill.name);
        else return false;
        return true;
      }
      const move = (delta: number) => {
        cancelHover();
        setActiveIndex((active + delta + rows.length) % rows.length);
      };
      const actions = {
        down: () => move(1),
        up: () => move(-1),
        select: () => insert(rows[active]!.skill.name),
        close: () => {
          cancelHover();
          typeahead.dismiss();
        },
        view: () => view(rows[active]!.skill.name),
      } satisfies Record<ComposerMenuKey, () => void>;
      actions[key]();
      return true;
    });
  });

  // A text box supports these. `aria-expanded` needs the combobox role.
  useEffect(() => {
    if (!textbox) return;
    const attributes = {
      "aria-activedescendant": open ? cellId(active) : undefined,
      "aria-controls": open ? gridId : undefined,
      "aria-describedby": cardSkill
        ? `${cardId}-source ${cardId}-description`
        : undefined,
    };
    for (const [name, value] of Object.entries(attributes)) {
      if (value) textbox.setAttribute(name, value);
    }
    return () => {
      for (const [name, value] of Object.entries(attributes)) {
        if (value) textbox.removeAttribute(name);
      }
    };
  });

  // Shared by the menu and the card, which take the same place.
  const popupProps = {
    ref: menuRef,
    style: placement,
    // Keep focus and the caret in the text box on desktop.
    onMouseDown: (event: MouseEvent) => event.preventDefault(),
    onPointerDown: () => hold(true),
    onPointerCancel: () => hold(false),
    // A tap moved focus out of the text box. Put it back.
    onClick: () => {
      if (viewingRef.current) return;
      hold(false);
      typeahead.focus();
    },
  };

  // A portal, because docks around the composer clip their overflow.
  return (
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
              className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-input bg-secondary p-3 shadow-lg"
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
}

const HOVER_DWELL_MS = 120;

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
        // The popup's own click puts focus back in the text box. The drawer
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
