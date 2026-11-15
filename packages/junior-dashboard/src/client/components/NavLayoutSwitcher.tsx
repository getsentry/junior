import { PanelLeft, PanelTop, PanelsTopLeft } from "lucide-react";

import { useNavLayoutChoice, type NavLayoutChoice } from "../navLayout";
import { PreferenceToggle, type PreferenceChoice } from "./PreferenceToggle";

/** Desktop navigation options, shared by this toggle and Settings. */
export const navLayoutChoices = [
  {
    description: "Top bar on tall windows, sidebar on shorter ones.",
    Icon: PanelsTopLeft,
    label: "Adaptive",
    value: "adaptive",
  },
  {
    description: "Always show the top bar.",
    Icon: PanelTop,
    label: "Top bar",
    value: "top-bar",
  },
  {
    description: "Always show the sidebar.",
    Icon: PanelLeft,
    label: "Sidebar",
    value: "sidebar",
  },
] as const satisfies ReadonlyArray<
  PreferenceChoice<NavLayoutChoice> & { description: string }
>;

/**
 * Choose desktop navigation for this browser: adaptive (top bar on tall
 * windows), top bar, or sidebar.
 */
export function NavLayoutSwitcher(props: {
  className?: string;
  menu?: boolean;
}) {
  const [choice, setChoice] = useNavLayoutChoice();
  return (
    <PreferenceToggle<NavLayoutChoice>
      choices={navLayoutChoices}
      className={props.className}
      itemLabel={(item) => `${item.label} navigation`}
      menu={props.menu}
      label="Navigation"
      onChange={setChoice}
      value={choice}
    />
  );
}
