import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";

import {
  USER_CUSTOMIZATION_MAX_CHARS,
  userCustomizationSchema,
} from "@sentry/junior/api/schema";
import {
  dashboardIdentitySchema,
  type DashboardIdentity,
} from "../../../api/schema";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { Checkbox } from "../../components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "../../components/ui/field";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import {
  useConversationStartPosition,
  type ConversationStartPosition,
} from "../../conversations/transcriptReadPosition";
import { useComposerAutocorrect } from "../../conversations/composerAutocorrect";
import { navLayoutChoices } from "../../components/NavLayoutSwitcher";
import { useNavLayoutChoice, type NavLayoutChoice } from "../../navLayout";
import { InlineError } from "../../components/InlineError";
import { AnchorHeading } from "../../components/layout/AnchorHeading";
import { Card } from "../../components/layout/Card";
import { NotificationSettingsCard } from "../../notifications/NotificationSettingsCard";
import { DashboardApiError, fetchDashboardJson, patch, put } from "../../http";
import type { DashboardCoreData } from "../../types";
import { AutoArchiveSettings } from "./AutoArchiveSettings";
import { SettingsPageLayout } from "./SettingsPageLayout";

const dashboardCoreQueryKey = ["dashboard", "core"] as const;
const userCustomizationQueryKey = ["dashboard", "user-customization"] as const;
const USER_CUSTOMIZATION_PATH = "/api/user-customization";

type SettingsPageProps = {
  identity: DashboardIdentity;
};

/** Let the signed-in user manage their dashboard profile. */
export function SettingsPage({ identity }: SettingsPageProps) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(identity.user.name ?? "");
  useEffect(() => {
    setDisplayName(identity.user.name ?? "");
  }, [identity.user.name]);
  const updateProfile = useMutation({
    mutationFn: (name: string) =>
      patch(dashboardIdentitySchema, "/api/me", { displayName: name }),
    onSuccess: (updated) => {
      queryClient.setQueryData<DashboardCoreData>(
        dashboardCoreQueryKey,
        (current) => (current ? { ...current, me: updated } : current),
      );
      setDisplayName(updated.user.name ?? "");
    },
  });
  const savedName = identity.user.name?.trim() ?? "";
  const trimmedName = displayName.trim();
  const canSave =
    trimmedName.length > 0 &&
    trimmedName.length <= 80 &&
    trimmedName !== savedName &&
    !updateProfile.isPending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSave) updateProfile.mutate(trimmedName);
  }

  return (
    <SettingsPageLayout section="general">
      <form onSubmit={submit}>
        <Card padding="md" variant="raised">
          <AnchorHeading
            anchor="profile"
            className="m-0 text-lg font-bold"
            title="Profile"
          />
          <Field className="mt-5">
            <FieldLabel htmlFor="display-name">Display name</FieldLabel>
            <Input
              autoComplete="name"
              id="display-name"
              maxLength={80}
              onChange={(event) => {
                setDisplayName(event.target.value);
                if (updateProfile.isError || updateProfile.isSuccess) {
                  updateProfile.reset();
                }
              }}
              value={displayName}
            />
            <FieldDescription id="display-name-help">
              Your display name is shown with your conversations and activity.
            </FieldDescription>
          </Field>
          <div className="mt-5 flex items-center gap-3">
            <Button disabled={!canSave} type="submit">
              {updateProfile.isPending ? "Saving…" : "Save changes"}
            </Button>
            {updateProfile.isSuccess ? (
              <p className="m-0 text-sm text-emerald-300">Changes saved.</p>
            ) : null}
            {updateProfile.isError ? (
              <InlineError>
                Could not save your display name. Try again.
              </InlineError>
            ) : null}
          </div>
        </Card>
      </form>
      <NavLayoutSetting />
      <ConversationStartSetting />
      <ComposerAutocorrectSetting />
      <AutoArchiveSettings identity={identity} />
      <NotificationSettingsCard />
      <CustomizationForm />
    </SettingsPageLayout>
  );
}

/** Let the user choose desktop navigation on this browser. Phones skip it. */
function NavLayoutSetting() {
  const [choice, setChoice] = useNavLayoutChoice();
  return (
    <Card className="hidden md:block" padding="md" variant="raised">
      <AnchorHeading
        anchor="navigation"
        className="m-0 text-lg font-bold"
        title="Navigation"
      />
      <p className="mt-1 mb-4 text-sm text-dashboard-text-muted">
        This choice applies to this browser.
      </p>
      <RadioGroup<NavLayoutChoice>
        aria-label="Navigation"
        className="grid gap-3"
        onValueChange={setChoice}
        value={choice}
      >
        {navLayoutChoices.map((option) => (
          <label
            className="flex cursor-pointer items-start gap-3"
            key={option.value}
          >
            <RadioGroupItem className="mt-0.5" value={option.value} />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{option.label}</span>
              <span className="text-xs text-dashboard-text-muted">
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </Card>
  );
}

const startPositionOptions: {
  description: string;
  label: string;
  value: ConversationStartPosition;
}[] = [
  {
    description: "Open at the first new message, below a “New” line.",
    label: "Where I left off",
    value: "unread",
  },
  {
    description: "Always open at the newest message.",
    label: "Latest message",
    value: "latest",
  },
];

/** Let the user choose where a Conversation opens on this browser. */
function ConversationStartSetting() {
  const [startPosition, setStartPosition] = useConversationStartPosition();
  return (
    <Card padding="md" variant="raised">
      <AnchorHeading
        anchor="open-conversations-at"
        className="m-0 text-lg font-bold"
        title="Open conversations at"
      />
      <p className="mt-1 mb-4 text-sm text-dashboard-text-muted">
        Junior keeps your place in each conversation on all your devices. This
        choice applies to this browser.
      </p>
      <RadioGroup<ConversationStartPosition>
        aria-label="Open conversations at"
        className="grid gap-3"
        onValueChange={setStartPosition}
        value={startPosition}
      >
        {startPositionOptions.map((option) => (
          <label
            className="flex cursor-pointer items-start gap-3"
            key={option.value}
          >
            <RadioGroupItem className="mt-0.5" value={option.value} />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{option.label}</span>
              <span className="text-xs text-dashboard-text-muted">
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </Card>
  );
}

/** Let the user turn on keyboard autocorrect in the composer on this browser. */
function ComposerAutocorrectSetting() {
  const [autocorrect, setAutocorrect] = useComposerAutocorrect();
  return (
    <Card padding="md" variant="raised">
      <AnchorHeading
        anchor="message-box"
        className="m-0 text-lg font-bold"
        title="Message box"
      />
      <label className="mt-4 flex cursor-pointer items-start gap-3">
        <Checkbox
          checked={autocorrect}
          className="mt-0.5"
          onCheckedChange={setAutocorrect}
        />
        <span className="grid gap-0.5">
          <span className="text-sm font-medium">Autocorrect</span>
          <span className="text-xs text-dashboard-text-muted">
            Let your keyboard correct spelling and capitalize sentences as you
            type. This can change ids, paths, and code. This choice applies to
            this browser.
          </span>
        </span>
      </label>
    </Card>
  );
}

/**
 * Let the user save text that changes how the agent replies to them. The
 * server returns 404 when the app does not enable this experiment.
 */
function CustomizationForm() {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const customizationQuery = useQuery({
    queryKey: userCustomizationQueryKey,
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        userCustomizationSchema,
        USER_CUSTOMIZATION_PATH,
        signal,
      ),
    retry: false,
  });
  const savedText = customizationQuery.data?.customization;
  useEffect(() => {
    if (savedText !== undefined) setText(savedText);
  }, [savedText]);
  const save = useMutation({
    mutationFn: (customization: string) =>
      put(userCustomizationSchema, USER_CUSTOMIZATION_PATH, { customization }),
    onSuccess: (updated) => {
      queryClient.setQueryData(userCustomizationQueryKey, updated);
    },
  });
  if (
    customizationQuery.error instanceof DashboardApiError &&
    customizationQuery.error.status === 404
  ) {
    return null;
  }
  if (savedText === undefined) {
    return customizationQuery.isError ? (
      <InlineError>Could not load your customization.</InlineError>
    ) : null;
  }
  const canSave =
    text.trim() !== savedText &&
    text.trim().length <= USER_CUSTOMIZATION_MAX_CHARS &&
    !save.isPending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSave) save.mutate(text.trim());
  }

  return (
    <form onSubmit={submit}>
      <Card padding="md" variant="raised">
        <AnchorHeading
          anchor="customization"
          className="m-0 text-lg font-bold"
          title="Customization"
        />
        <Field className="mt-5">
          <FieldLabel htmlFor="user-customization">
            How should replies to you change?
          </FieldLabel>
          <Textarea
            id="user-customization"
            maxLength={USER_CUSTOMIZATION_MAX_CHARS}
            onChange={(event) => {
              setText(event.target.value);
              if (save.isError || save.isSuccess) save.reset();
            }}
            placeholder="Keep replies short and simple."
            value={text}
          />
          <FieldDescription>
            Added to each message you send. Do not put secrets here. (
            {text.trim().length}/{USER_CUSTOMIZATION_MAX_CHARS})
          </FieldDescription>
        </Field>
        <div className="mt-5 flex items-center gap-3">
          <Button disabled={!canSave} type="submit">
            {save.isPending ? "Saving…" : "Save customization"}
          </Button>
          {save.isSuccess ? (
            <p className="m-0 text-sm text-emerald-300">Changes saved.</p>
          ) : null}
          {save.isError ? (
            <InlineError>
              Could not save your customization. Try again.
            </InlineError>
          ) : null}
        </div>
      </Card>
    </form>
  );
}
