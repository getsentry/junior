import { SlidersHorizontal } from "lucide-react";
import type { SpaceReport } from "@sentry/junior/api/schema";

import { getDashboardAgentName } from "../agentName";
import { Skeleton } from "../components/ui/skeleton";
import {
  DetailsList,
  DetailsRow,
  DetailsRowLine,
} from "../conversations/DetailsList";
import { useSpaceConfigurationData } from "./queries";

/**
 * A Space's settings: the configuration that applies to every Conversation
 * in it. The agent changes them when a member asks it to, so the page
 * only shows them.
 */
export function SpaceSettings(props: { space: SpaceReport }) {
  const configuration = useSpaceConfigurationData(props.space.id);
  if (configuration.error) {
    return <p className="m-0">Settings are unavailable.</p>;
  }
  if (!configuration.data) return <Skeleton className="h-4 w-1/2" />;
  const { entries } = configuration.data;
  if (entries.length === 0) {
    return (
      <p className="m-0">
        No settings. Ask {getDashboardAgentName()} to set one.
      </p>
    );
  }
  return (
    <DetailsList
      itemKey={(entry) => entry.key}
      items={entries}
      renderItem={(entry) => (
        <DetailsRow
          icon={<SlidersHorizontal aria-hidden="true" size={14} />}
          title={entry.key}
        >
          <DetailsRowLine className="truncate">
            {typeof entry.value === "string"
              ? entry.value
              : JSON.stringify(entry.value)}
          </DetailsRowLine>
        </DetailsRow>
      )}
    />
  );
}
