import { Pin } from "lucide-react";

import { ScopeTabs } from "../components/filters/ScopeTabs";

/** The search param that shows only the viewer's pins. Off is the default. */
const PINNED_PARAM = "pinned";

/** Read from the URL whether the list shows only the viewer's pins. */
export function pinnedOnlyOf(search: URLSearchParams): boolean {
  return search.get(PINNED_PARAM) === "1";
}

/** Toggle between every row and only the viewer's pinned Conversations. */
export function PinnedFilter(props: { on: boolean; search: string }) {
  const params = new URLSearchParams(props.search);
  if (props.on) params.delete(PINNED_PARAM);
  else params.set(PINNED_PARAM, "1");
  return (
    <ScopeTabs
      label="Rows to show"
      tabs={[
        {
          icon: Pin,
          label: "Pinned only",
          on: props.on,
          search: params.toString(),
        },
      ]}
    />
  );
}
