import { Link2, Type } from "lucide-react";

import { useLinkModeChoice, type LinkMode } from "../display-text/DisplayText";
import { PreferenceToggle, type PreferenceChoice } from "./PreferenceToggle";

const linkModeChoices = [
  { Icon: Link2, label: "Rich", value: "rich" },
  { Icon: Type, label: "Plain", value: "plain" },
] as const satisfies ReadonlyArray<PreferenceChoice<LinkMode>>;

/** Choose how links show for this browser: rich or plain. */
export function LinkModeSwitcher(props: {
  className?: string;
  menu?: boolean;
}) {
  const [mode, setMode] = useLinkModeChoice();
  return (
    <PreferenceToggle<LinkMode>
      choices={linkModeChoices}
      className={props.className}
      itemLabel={(item) => `${item.label} links`}
      menu={props.menu}
      label="Links"
      onChange={setMode}
      value={mode}
    />
  );
}
