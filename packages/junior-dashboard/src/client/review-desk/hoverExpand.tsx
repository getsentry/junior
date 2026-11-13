import { CircleOff, Expand, Rows3 } from "lucide-react";
import {
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  PreferenceToggle,
  type PreferenceChoice,
} from "../components/PreferenceToggle";
import { useConversationDensity } from "../conversations/conversationDensity";
import { DOCK_MEDIA } from "./useDockHover";

/** Which Inbox rows show more of themselves while the pointer rests on them. */
type HoverExpand = "compact" | "everywhere" | "off";

const STORAGE_KEY = "junior:hover-expand";
const CHANGE_EVENT = "junior:hover-expand-change";
/** How long the pointer rests on a row before it shows more. */
const HOVER_INTENT_MS = 275;

function readHoverExpand(): HoverExpand {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "off" || value === "everywhere" ? value : "compact";
  } catch {
    return "compact";
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function saveHoverExpand(value: HoverExpand): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage is blocked, so rows keep the default.
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function useHoverExpandSetting(): [HoverExpand, (value: HoverExpand) => void] {
  const value = useSyncExternalStore(
    subscribe,
    readHoverExpand,
    () => "compact" as const,
  );
  return [value, saveHoverExpand];
}

const choices = [
  { Icon: CircleOff, label: "Off", value: "off" },
  { Icon: Rows3, label: "Compact only", value: "compact" },
  { Icon: Expand, label: "Everywhere", value: "everywhere" },
] as const satisfies ReadonlyArray<PreferenceChoice<HoverExpand>>;

/** Choose which rows expand on hover, next to the density choice. */
export function HoverExpandSwitcher(props: {
  className?: string;
  menu?: boolean;
}) {
  const [value, setValue] = useHoverExpandSetting();
  return (
    <PreferenceToggle<HoverExpand>
      choices={choices}
      className={props.className}
      itemLabel={(choice) => `Expand on hover: ${choice.label}`}
      label="Expand on hover"
      menu={props.menu}
      onChange={setValue}
      value={value}
    />
  );
}

/**
 * Show more of an Inbox row after the pointer rests on it, as the viewer's
 * "Expand on hover" setting allows for the current density. A mouse only:
 * touch, pen and reduced motion never expand. Spread the handlers on the
 * row; `shown` stays false while the row is open.
 */
export function useHoverExpand(open: boolean) {
  const [setting] = useHoverExpandSetting();
  const [density] = useConversationDensity();
  const allowed =
    !open &&
    (setting === "everywhere" ||
      (setting === "compact" && density === "compact"));
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setShown(false);
  }, []);
  useEffect(() => {
    if (!allowed) close();
    return () => clearTimeout(timer.current);
  }, [allowed, close]);

  const onPointerEnter = useCallback(
    (event: PointerEvent) => {
      if (!allowed || event.pointerType !== "mouse") return;
      if (!window.matchMedia(DOCK_MEDIA).matches) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setShown(true), HOVER_INTENT_MS);
    },
    [allowed],
  );
  return {
    handlers: {
      onPointerDown: close,
      onPointerEnter,
      onPointerLeave: close,
    },
    shown: allowed && shown,
  };
}
