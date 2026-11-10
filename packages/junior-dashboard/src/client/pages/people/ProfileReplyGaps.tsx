import { usePersonReplyGapsData } from "../../api";
import { ChartHeader } from "../../components/charts/ChartHeader";
import { ReplyGapHistogram } from "../../components/charts/ReplyGapHistogram";
import {
  timeRangeDetail,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { anchorTitleId } from "../../components/layout/AnchorHeading";
import { Card } from "../../components/layout/Card";
import { SectionIntro } from "../../components/layout/SectionIntro";
import { formatCompactNumber } from "../../format";

/**
 * Show the viewer's own reply gaps on their profile. The server returns them
 * only to the profile's person, so the profile renders this only then.
 */
export function ProfileReplyGaps(props: {
  email: string;
  range: TimeRangeDays;
}) {
  const query = usePersonReplyGapsData({
    days: props.range,
    email: props.email,
  });
  if (!query.data) return null;
  const { histogram } = query.data;
  return (
    <section
      aria-labelledby={anchorTitleId("reply-gaps")}
      className="grid gap-4"
    >
      <SectionIntro
        anchor="reply-gaps"
        description={`Time from a reply to your next message in the ${timeRangeDetail(props.range)}, in the cache warming bins. Only you see this.`}
        title="Your reply gaps"
      />
      <Card>
        <ChartHeader
          title="Gaps"
          total={formatCompactNumber(histogram.total)}
        />
        <div className="px-2 py-3">
          <ReplyGapHistogram histogram={histogram} />
        </div>
      </Card>
    </section>
  );
}
