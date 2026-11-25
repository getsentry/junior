import { SlidersHorizontal, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type { SpaceReport } from "@sentry/junior/api/schema";

import { InlineError } from "../components/InlineError";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import {
  DetailsCard,
  DetailsList,
  DetailsRow,
  DetailsRowLine,
} from "../conversations/DetailsList";
import { DashboardApiError } from "../http";
import {
  useRemoveSpaceConfiguration,
  useSetSpaceConfiguration,
  useSpaceConfigurationData,
} from "./queries";

function errorText(error: Error): string {
  return error instanceof DashboardApiError
    ? (error.apiError ?? "Try again.")
    : error.message;
}

/**
 * A Space's settings: the configuration that applies to every Conversation
 * in it. Members add, replace, and remove values. Others only read them.
 */
export function SpaceSettings(props: { space: SpaceReport }) {
  const { space } = props;
  const configuration = useSpaceConfigurationData(space.id);
  const remove = useRemoveSpaceConfiguration(space.id);
  const entries = configuration.data?.entries ?? [];
  return (
    <DetailsCard count={entries.length} label="Settings" title="Settings">
      {configuration.error ? (
        <p className="m-0">Settings are unavailable.</p>
      ) : !configuration.data ? (
        <Skeleton className="h-4 w-1/2" />
      ) : (
        <div className="grid gap-2">
          {entries.length === 0 ? (
            <p className="m-0">
              No settings. Conversations use the channel and install defaults.
            </p>
          ) : (
            <DetailsList
              itemKey={(entry) => entry.key}
              items={entries}
              renderItem={(entry) => (
                <DetailsRow
                  icon={<SlidersHorizontal aria-hidden="true" size={14} />}
                  meta={
                    space.viewerIsMember ? (
                      <Button
                        aria-label={`Remove ${entry.key}`}
                        className="size-5 rounded"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(entry.key)}
                        size="icon"
                        variant="ghost"
                      >
                        <X aria-hidden="true" size={14} />
                      </Button>
                    ) : null
                  }
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
          )}
          {remove.error ? (
            <InlineError>{errorText(remove.error)}</InlineError>
          ) : null}
          {space.viewerIsMember ? (
            <SettingForm keys={configuration.data.keys} spaceId={space.id} />
          ) : null}
        </div>
      )}
    </DetailsCard>
  );
}

/** Add a value, or replace the value of a key that is already set. */
function SettingForm(props: { keys: string[]; spaceId: string }) {
  const keysId = useId();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const save = useSetSpaceConfiguration(props.spaceId);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    save.mutate(
      { key: key.trim(), value },
      {
        onSuccess: () => {
          setKey("");
          setValue("");
        },
      },
    );
  }

  return (
    <form
      aria-label="Add a setting"
      className="grid gap-1.5"
      onSubmit={onSubmit}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-1.5">
        <Input
          aria-label="Key"
          className="h-8 px-2 py-1"
          list={keysId}
          onChange={(event) => {
            setKey(event.target.value);
            save.reset();
          }}
          placeholder="Key"
          value={key}
        />
        <Input
          aria-label="Value"
          className="h-8 px-2 py-1"
          onChange={(event) => {
            setValue(event.target.value);
            save.reset();
          }}
          placeholder="Value"
          value={value}
        />
        <Button
          className="h-8"
          disabled={!key.trim() || !value || save.isPending}
          type="submit"
          variant="outline"
        >
          Save
        </Button>
      </div>
      <datalist id={keysId}>
        {props.keys.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
      {save.error ? <InlineError>{errorText(save.error)}</InlineError> : null}
    </form>
  );
}
