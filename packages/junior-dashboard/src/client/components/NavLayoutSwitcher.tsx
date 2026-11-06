import { PanelLeft, PanelTop, PanelsTopLeft } from "lucide-react";

import { useNavLayoutChoice, type NavLayoutChoice } from "../navLayout";
import { PreferenceToggle, type PreferenceChoice } from "./PreferenceToggle";

const navLayoutChoices = [
  { Icon: PanelsTopLeft, label: "Adaptive", value: "adaptive" },
  { Icon: PanelTop, label: "Top bar", value: "top-bar" },
  { Icon: PanelLeft, label: "Sidebar", value: "sidebar" },
] as const satisfies ReadonlyArray<PreferenceChoice<NavLayoutChoice>>;

/**
 * Choose desktop navigation for this browser: adaptive (top bar on tall
 * windows), top bar, or sidebar.
 */
export function NavLayoutSwitcher(props: { className?: string }) {
  const [choice, setChoice] = useNavLayoutChoice();
  return (
    <PreferenceToggle
      choices={navLayoutChoices}
      className={props.className}
      itemLabel={(item) => `${item.label} navigation`}
      label="Navigation"
      onChange={setChoice}
      value={choice}
    />
  );
}
