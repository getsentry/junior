import { useMutation } from "@tanstack/react-query";
import { createdPersonalTokenSchema } from "@sentry/junior/api/schema";
import { getDashboardAgentName } from "../../agentName";
import { Button } from "../../components/ui/button";
import { InlineError } from "../../components/InlineError";
import { DashboardApiError, post } from "../../http";

/** Return `value` when it is an http(s) origin, such as a Preview URL. */
export function parsePreviewOrigin(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

// The example app's live preview reads the token from this form POST.
function sendTokenToPreview(previewOrigin: string, token: string): void {
  const form = document.createElement("form");
  form.method = "post";
  form.action = `${previewOrigin}/?live`;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "token";
  input.value = token;
  form.append(input);
  document.body.append(form);
  form.submit();
}

/**
 * Create a personal token for a Preview that Junior made for the viewer, and
 * send it to the Preview. The API refuses any other Preview.
 */
export function PreviewTokenHandoff(props: {
  onCancel: () => void;
  previewOrigin: string;
}) {
  const host = new URL(props.previewOrigin).host;
  const sendToken = useMutation({
    mutationFn: () =>
      post(createdPersonalTokenSchema, "/api/personal-tokens", {
        name: `Live preview on ${host}`.slice(0, 80),
        previewOrigin: props.previewOrigin,
      }),
    onSuccess: (created) =>
      sendTokenToPreview(props.previewOrigin, created.token),
  });
  const error = sendToken.isError
    ? sendToken.error instanceof DashboardApiError &&
      sendToken.error.status === 403
      ? `${getDashboardAgentName()} did not make ${host} for you. Paste a token there instead.`
      : "Could not create the API token. Try again."
    : undefined;

  return (
    <div className="rounded-md border border-dashboard-border-emphasis p-3">
      <p className="mt-0 mb-1 text-sm font-semibold">
        Send a read-only token to {host}?
      </p>
      <p className="mt-0 mb-3 text-sm text-dashboard-text-muted">
        The Preview can then read your {getDashboardAgentName()} data until you
        revoke the token. Continue only if you opened this from your Preview.
      </p>
      {error ? <InlineError className="mb-3">{error}</InlineError> : null}
      <div className="flex gap-2">
        <Button
          disabled={sendToken.isPending || sendToken.isSuccess}
          onClick={() => sendToken.mutate()}
          type="button"
        >
          Send token
        </Button>
        <Button onClick={props.onCancel} type="button" variant="outline">
          Cancel
        </Button>
      </div>
    </div>
  );
}
