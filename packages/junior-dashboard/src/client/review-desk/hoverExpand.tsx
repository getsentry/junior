import { CircleOff, Expand, Rows3 } from "lucide-react";
import { useSyncExternalStore } from "react";

import {
  PreferenceToggle,
  type PreferenceChoice,
} from "../components/PreferenceToggle";
import { useConversationDensity } from "../conversations/conversationDensity";

/** Which Inbox rows expand in place while the pointer rests on them. */
type HoverExpand = "compact" | "everywhere" | "off";

const STORAGE_KEY = "junior:hover-expand";
const CHANGE_EVENT = "junior:hover-expand-change";

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
 * Whether an Inbox row in focus expands in place, as the viewer's "Expand
 * on hover" setting allows for the current density. Focus comes from the
 * pointer (`useInboxRowFocused`), so touch and reduced motion never expand.
 */
export function useHoverExpandAllowed(): boolean {
  const [setting] = useHoverExpandSetting();
  const [density] = useConversationDensity();
  return (
    setting === "everywhere" || (setting === "compact" && density === "compact")
  );
}
