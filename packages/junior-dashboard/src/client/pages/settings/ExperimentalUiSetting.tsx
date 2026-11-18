import { useMutation } from "@tanstack/react-query";

import {
  dashboardIdentitySchema,
  type DashboardIdentity,
} from "../../../api/schema";
import { InlineError } from "../../components/InlineError";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "../../components/ui/field";
import { patch } from "../../http";
import { SettingFrame, type SettingFrameKind } from "./SettingFrame";

/**
 * Let the user turn the new dashboard on or off. Both dashboards show it, so
 * a user can always go back.
 */
export function ExperimentalUiSetting(props: {
  frame?: SettingFrameKind;
  identity: DashboardIdentity;
}) {
  const change = useMutation({
    mutationFn: (experimentalUi: boolean) =>
      patch(dashboardIdentitySchema, "/api/me", { experimentalUi }),
    // The page picks its dashboard when it loads.
    onSuccess: () => window.location.reload(),
  });
  return (
    <SettingFrame
      anchor="new-dashboard"
      frame={props.frame}
      title="New dashboard"
    >
      <Field className="mt-4" orientation="horizontal">
        <Checkbox
          aria-describedby="experimental-ui-help"
          checked={props.identity.experimentalUi ?? false}
          disabled={change.isPending}
          id="experimental-ui"
          onCheckedChange={(checked) => change.mutate(checked)}
        />
        <FieldContent>
          <FieldLabel htmlFor="experimental-ui">
            Try the new dashboard
          </FieldLabel>
          <FieldDescription id="experimental-ui-help">
            Use the new dashboard, with an Inbox for what needs you. Turn this
            off to go back.
          </FieldDescription>
        </FieldContent>
      </Field>
      {change.isError ? (
        <InlineError className="mt-3">
          Could not change the dashboard. Try again.
        </InlineError>
      ) : null}
    </SettingFrame>
  );
}
