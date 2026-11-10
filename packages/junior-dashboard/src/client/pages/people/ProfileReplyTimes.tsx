import { usePersonReplyTimesData } from "../../api";
import { ChartHeader } from "../../components/charts/ChartHeader";
import {
  ReplyTimeHistogram,
  replyTimeSummary,
} from "../../components/charts/ReplyTimeHistogram";
import {
  timeRangeDetail,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { anchorTitleId } from "../../components/layout/AnchorHeading";
import { Card } from "../../components/layout/Card";
import { SectionIntro } from "../../components/layout/SectionIntro";
import { formatCompactNumber } from "../../format";

/**
 * Show the viewer's own reply times on their profile. The server returns them
 * only to the profile's person, so the profile renders this only then.
 */
export function ProfileReplyTimes(props: {
  email: string;
  range: TimeRangeDays;
}) {
  const query = usePersonReplyTimesData({
    days: props.range,
    email: props.email,
  });
  if (!query.data) return null;
  const { histogram } = query.data;
  const summary = replyTimeSummary(histogram);
  return (
    <section
      aria-labelledby={anchorTitleId("reply-times")}
      className="grid gap-4"
    >
      <SectionIntro
        anchor="reply-times"
        description={`How long you take to send your next message after Junior answers, in the ${timeRangeDetail(props.range)}. Only you see this.`}
        title="Your reply times"
      />
      <Card>
        <ChartHeader
          description={
            summary.noReplyShare
              ? `${formatCompactNumber(summary.replies)} replies within 55 minutes. ${summary.noReplyShare} of your replies came later.`
              : "No replies in this time window."
          }
          title="Replies"
          total={summary.median ?? "—"}
          totalLabel="typical reply"
        />
        <div className="px-2 py-3">
          <ReplyTimeHistogram histogram={histogram} />
        </div>
      </Card>
    </section>
  );
}
