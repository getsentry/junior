import { useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { TriangleAlert } from "lucide-react";
import type {
  PluginOperationalReport,
  PluginReport,
  SkillReport,
} from "@sentry/junior/api/schema";

import { PluginReports } from "../../components/PluginReports";
import { Card } from "../../components/layout/Card";
import { cn } from "../../styles";
import { PluginInventory } from "./PluginInventory";
import { SkillInventory } from "./SkillInventory";

type CapabilityTab = "plugins" | "skills";

/** Render the System capability inventories as an accessible tab set. */
export function SystemCapabilities(props: {
  loadingReports: boolean;
  pluginReportsError: boolean;
  plugins: PluginReport[];
  reports: PluginOperationalReport[];
  skills: SkillReport[];
}) {
  const [activeTab, setActiveTab] = useState<CapabilityTab>("plugins");
  const pluginTabRef = useRef<HTMLButtonElement>(null);
  const skillTabRef = useRef<HTMLButtonElement>(null);
  const reportEmptyText = props.pluginReportsError
    ? undefined
    : props.loadingReports
      ? "Loading plugin stats."
      : "No plugins have been reported yet.";

  return (
    <section aria-label="Capabilities">
      <div
        aria-label="Capability inventories"
        className="mb-3 flex gap-1 border-b border-white/[0.07]"
        role="tablist"
      >
        <CapabilityTabButton
          activeTab={activeTab}
          buttonRef={pluginTabRef}
          label="Plugins"
          tab="plugins"
          onSelect={setActiveTab}
          onNavigate={(tab) => {
            setActiveTab(tab);
            (tab === "plugins" ? pluginTabRef : skillTabRef).current?.focus();
          }}
        />
        <CapabilityTabButton
          activeTab={activeTab}
          buttonRef={skillTabRef}
          label="Skills"
          tab="skills"
          onSelect={setActiveTab}
          onNavigate={(tab) => {
            setActiveTab(tab);
            (tab === "plugins" ? pluginTabRef : skillTabRef).current?.focus();
          }}
        />
      </div>
      <div
        aria-labelledby="plugins-tab"
        hidden={activeTab !== "plugins"}
        id="plugins-panel"
        role="tabpanel"
      >
        <div className="grid gap-4 sm:gap-6">
          <PluginInventory
            loadingReports={props.loadingReports}
            plugins={props.plugins}
            reports={props.reports}
          />
          {props.pluginReportsError ? (
            <Card
              className="border-amber-300/10 bg-amber-300/[0.025]"
              padding="sm"
            >
              <div className="flex items-center gap-3">
                <div className="grid size-9 shrink-0 place-items-center rounded border border-amber-300/15 bg-amber-300/[0.055] text-amber-200/70">
                  <TriangleAlert aria-hidden="true" size={15} />
                </div>
                <div>
                  <div className="font-display text-sm font-medium text-white/75">
                    Plugin stats failed to load.
                  </div>
                  <div className="mt-1 font-mono text-[0.64rem] leading-relaxed text-white/30">
                    {props.reports.length
                      ? "Showing the last operational reports Junior received."
                      : "Loaded capabilities are still available above."}
                  </div>
                </div>
              </div>
            </Card>
          ) : null}
          <PluginReports emptyText={reportEmptyText} reports={props.reports} />
        </div>
      </div>
      <div
        aria-labelledby="skills-tab"
        hidden={activeTab !== "skills"}
        id="skills-panel"
        role="tabpanel"
      >
        {activeTab === "skills" ? (
          <SkillInventory skills={props.skills} />
        ) : null}
      </div>
    </section>
  );
}

function CapabilityTabButton(props: {
  activeTab: CapabilityTab;
  buttonRef: RefObject<HTMLButtonElement | null>;
  label: string;
  onNavigate: (tab: CapabilityTab) => void;
  onSelect: (tab: CapabilityTab) => void;
  tab: CapabilityTab;
}) {
  const active = props.activeTab === props.tab;
  return (
    <button
      aria-controls={`${props.tab}-panel`}
      aria-selected={active}
      className={cn(
        "relative cursor-pointer border-0 bg-transparent px-4 py-3 font-mono text-[0.68rem] font-medium uppercase tracking-[0.12em] transition-colors after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px",
        active
          ? "text-white after:bg-cyan-400"
          : "text-white/35 after:bg-transparent hover:text-white/70 hover:after:bg-white/20",
      )}
      id={`${props.tab}-tab`}
      onClick={() => props.onSelect(props.tab)}
      onKeyDown={(event) =>
        handleTabKeyDown(event, props.tab, props.onNavigate)
      }
      ref={props.buttonRef}
      role="tab"
      tabIndex={active ? 0 : -1}
      type="button"
    >
      {props.label}
    </button>
  );
}

function handleTabKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  currentTab: CapabilityTab,
  onNavigate: (tab: CapabilityTab) => void,
) {
  if (
    event.key !== "ArrowLeft" &&
    event.key !== "ArrowRight" &&
    event.key !== "Home" &&
    event.key !== "End"
  ) {
    return;
  }
  event.preventDefault();
  if (event.key === "Home") {
    onNavigate("plugins");
  } else if (event.key === "End") {
    onNavigate("skills");
  } else {
    onNavigate(currentTab === "plugins" ? "skills" : "plugins");
  }
}
