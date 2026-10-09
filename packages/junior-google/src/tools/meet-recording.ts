import { z } from "zod";
import {
  googleApiError,
  googleApiRequest,
  type GoogleToolContext,
  type OwnEvent,
} from "./shared";

const spaceSchema = z.object({ name: z.string().regex(/^spaces\/[\w-]+$/) });

/** Line added to the event description so invitees know before they join. */
export const RECORDING_NOTICE =
  "This meeting is recorded. Google Meet starts the recording automatically.";

/** Output fields for an event that the requester asked to record. */
export const recordingOutputFields = {
  recording: z
    .enum(["on", "failed"])
    .optional()
    .describe(
      "`on` when Google Meet auto-recording is set. `failed` when the event exists but recording is not set; tell the requester.",
    ),
  recordingError: z.string().optional(),
};

/**
 * Turn on Google Meet auto-recording for the Meet space of Junior's event.
 *
 * The invites are already sent when this runs, so a failure is reported in
 * the result instead of failing the tool call. Google saves the recording to
 * the organizer's Drive, which is Junior's account, and adds the link to the
 * Calendar event.
 */
export async function turnOnAutoRecording(
  ctx: GoogleToolContext,
  event: OwnEvent,
): Promise<
  { recording: "on" } | { recording: "failed"; recordingError: string }
> {
  const meetingCode = event.conferenceData?.conferenceId;
  if (!meetingCode || !/^[a-z]+-[a-z]+-[a-z]+$/.test(meetingCode)) {
    return {
      recording: "failed",
      recordingError:
        "Google did not return a Meet link for the event yet, so Junior could not turn on recording.",
    };
  }
  // A meeting code is an alias that only `spaces.get` accepts. Updates need
  // the space name.
  const space = await googleApiRequest(ctx, {
    operation: "google.meet.space.get",
    path: `/v2/spaces/${meetingCode}`,
  });
  if (space.status !== 200) {
    return failed(googleApiError("google.meet.space.get", space));
  }
  const { name } = spaceSchema.parse(space.body);
  const update = await googleApiRequest(ctx, {
    body: {
      config: {
        artifactConfig: {
          recordingConfig: { autoRecordingGeneration: "ON" },
        },
      },
    },
    operation: "google.meet.space.update",
    path: `/v2/${name}`,
    query: {
      updateMask:
        "config.artifactConfig.recordingConfig.autoRecordingGeneration",
    },
  });
  if (update.status !== 200) {
    return failed(googleApiError("google.meet.space.update", update));
  }
  return { recording: "on" };
}

function failed(error: Error) {
  const reconnect = /HTTP 403/.test(error.message)
    ? " A Junior admin may need to reconnect the Google account to grant Meet access."
    : "";
  return {
    recording: "failed" as const,
    recordingError: `${error.message}${reconnect}`,
  };
}
