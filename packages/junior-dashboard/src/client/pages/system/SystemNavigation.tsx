import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";
import { systemPluginsPath } from "./SystemPlugins";

const systemNavigationItems = [
  { end: true, label: "Overview", to: "/system" },
  { label: "People", to: "/system/people" },
  { label: "Locations", to: "/system/locations" },
  { label: "Plugins", to: systemPluginsPath },
];

/** Render the stable secondary navigation shared by System pages. */
export function SystemNavigation() {
  return (
    <SecondaryNavigation
      ariaLabel="System navigation"
      items={systemNavigationItems}
    />
  );
}
