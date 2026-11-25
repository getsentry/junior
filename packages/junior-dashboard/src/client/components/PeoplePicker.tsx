import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  userSearchReportSchema,
  type UserSearchResult,
} from "@sentry/junior/api/schema";
import { useDebouncedValue } from "../debouncedValue";
import { fetchDashboardJson } from "../http";
import { cn } from "../styles";
import { ActorAvatar } from "./ActorAvatar";
import {
  movePickerActive,
  pickerName,
  pickerOptions,
} from "./peoplePickerOptions";
import { Button } from "./ui/button";
import { FieldError } from "./ui/field";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";

// Wait for a pause in typing, so each keystroke does not send a search.
const SEARCH_DEBOUNCE_MS = 150;
// A person who types a name waits for the next keystroke, not fresh data.
const SEARCH_STALE_MS = 30_000;
// One add starts a request for each chosen person, so it takes a few.
const MAX_CHOSEN = 10;

/** The Space or Conversation that the picker adds people to. */
export type PeoplePickerTarget =
  | { spaceId: string }
  | { conversationId: string };

/** Query key of the people picker searches for one target. */
function userSearchKey(target: PeoplePickerTarget) {
  return ["dashboard", "people", "user-search", target] as const;
}

/**
 * Choose people by name, handle, or email, then add them all at once. Each
 * chosen person shows as a chip. The search marks a person who already
 * belongs, and they cannot be chosen. `add` adds one person; a person it
 * fails for stays chosen, with an error, and the rest are done.
 */
export function PeoplePicker(props: {
  add(user: UserSearchResult): Promise<void>;
  /** Names the search box, such as "Add members". */
  label: string;
  /** Says that a person already belongs, such as "Member". */
  memberLabel: string;
  onCancel(): void;
  onDone(): void;
  /** Text of the button that adds the chosen people. */
  submitLabel: string;
  target: PeoplePickerTarget;
}) {
  const ids = useId();
  const listboxId = `${ids}-listbox`;
  const errorId = `${ids}-error`;
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<UserSearchResult[]>([]);
  const [active, setActive] = useState(-1);
  const [adding, setAdding] = useState(false);
  // User ids that the last add failed for. Each one stays chosen.
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const failed = chosen
    .filter((user) => failedIds.includes(user.userId))
    .map(pickerName);
  const search = useUserSearch(props.target, query.trim());
  const options = pickerOptions(search.users, chosen);
  // A new result list highlights its first person who can be chosen.
  const [shownOptions, setShownOptions] = useState(options);
  if (
    shownOptions.length !== options.length ||
    shownOptions.some((user, index) => user.userId !== options[index]?.userId)
  ) {
    setShownOptions(options);
    setActive(movePickerActive(options, -1, 1));
  }
  const full = chosen.length >= MAX_CHOSEN;
  const open = query.trim().length > 0;
  const listed = open && !full && options.length > 0;
  // In a phone's details sheet, the list can push the form below the fold.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (listed) formRef.current?.scrollIntoView({ block: "nearest" });
  }, [listed, options.length]);

  const choose = (user: UserSearchResult) => {
    // A person chosen while an add runs would not be in that add.
    if (user.isMember || full || adding) return;
    setChosen((current) => [...current, user]);
    setQuery("");
    setFailedIds([]);
  };
  const unchoose = (userId: string) =>
    setChosen((current) => current.filter((user) => user.userId !== userId));

  const submit = async () => {
    if (chosen.length === 0 || adding) return;
    setAdding(true);
    const results = await Promise.allSettled(
      chosen.slice(0, MAX_CHOSEN).map(props.add),
    );
    setAdding(false);
    await queryClient.invalidateQueries({
      queryKey: userSearchKey(props.target),
    });
    const left = chosen.filter(
      (_, index) => results[index]!.status === "rejected",
    );
    if (left.length === 0) {
      props.onDone();
      return;
    }
    setChosen(left);
    setFailedIds(left.map((user) => user.userId));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!listed) return;
      event.preventDefault();
      setActive(
        movePickerActive(options, active, event.key === "ArrowDown" ? 1 : -1),
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Rows from the last query are stale until the new search answers.
      const option = listed && !search.pending ? options[active] : undefined;
      if (option) choose(option);
      else if (!open) void submit();
    } else if (event.key === "Escape") {
      // Escape clears the search first, then closes the picker.
      event.preventDefault();
      event.stopPropagation();
      if (query) setQuery("");
      else props.onCancel();
    } else if (
      event.key === "Backspace" &&
      !query &&
      event.currentTarget.selectionStart === 0
    ) {
      setChosen((current) => current.slice(0, -1));
    }
  };

  const activeUser = listed ? options[active] : undefined;
  return (
    <form
      className="grid gap-2 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      ref={formRef}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-input bg-dashboard-ink p-1.5 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/25">
        {chosen.length > 0 ? (
          <ul aria-label="Chosen people" className="contents list-none">
            {chosen.map((user) => (
              <li
                className="flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-md bg-dashboard-fill-strong pl-1.5 font-sans text-sm text-foreground"
                key={user.userId}
              >
                <ActorAvatar
                  imageUrl={user.avatarUrl}
                  name={pickerName(user)}
                  size="list"
                />
                <span className="min-w-0 truncate">{pickerName(user)}</span>
                <button
                  aria-label={`Remove ${pickerName(user)}`}
                  className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-dashboard-fill-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  disabled={adding}
                  onClick={() => unchoose(user.userId)}
                  type="button"
                >
                  <X aria-hidden="true" size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <Input
          aria-activedescendant={
            activeUser ? `${ids}-option-${activeUser.userId}` : undefined
          }
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-describedby={failed.length > 0 ? errorId : undefined}
          aria-expanded={listed}
          aria-label={props.label}
          autoComplete="off"
          autoFocus
          // 16px text on a phone, so the browser does not zoom in on focus.
          className="h-8 w-auto min-w-32 flex-1 border-0 bg-transparent px-1.5 py-0 text-base focus:ring-0 sm:text-sm"
          disabled={adding}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={chosen.length > 0 ? "" : "Name, handle, or email"}
          role="combobox"
          spellCheck={false}
          value={query}
        />
      </div>
      <div
        aria-busy={search.pending}
        aria-label="People"
        className={cn(
          "grid gap-0.5 rounded-md border border-input bg-secondary p-1",
          !listed && "hidden",
        )}
        id={listboxId}
        role="listbox"
      >
        {listed
          ? options.map((user, index) => (
              <div
                aria-disabled={user.isMember ? true : undefined}
                aria-selected={index === active}
                className={cn(
                  "flex min-h-11 min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 font-sans text-sm text-foreground select-none sm:min-h-9",
                  index === active && "bg-dashboard-fill-hover",
                  user.isMember && "cursor-default text-muted-foreground",
                )}
                id={`${ids}-option-${user.userId}`}
                key={user.userId}
                // Keep focus in the search box.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!search.pending) choose(user);
                }}
                onMouseMove={() => {
                  if (!user.isMember && index !== active) setActive(index);
                }}
                role="option"
              >
                <ActorAvatar
                  imageUrl={user.avatarUrl}
                  name={pickerName(user)}
                  size="list"
                />
                <span className="grid min-w-0 flex-1">
                  <span className="truncate">{pickerName(user)}</span>
                  <span className="truncate text-xs text-dashboard-text-muted">
                    {user.slackUserName
                      ? `@${user.slackUserName} · ${user.email}`
                      : user.email}
                  </span>
                </span>
                {user.isMember ? (
                  <span className="shrink-0 text-xs text-dashboard-text-muted">
                    {props.memberLabel}
                  </span>
                ) : null}
              </div>
            ))
          : null}
      </div>
      {open && !listed ? (
        <p
          className="m-0 flex items-center gap-2 px-1 font-sans text-xs text-dashboard-text-muted"
          role="status"
        >
          {full ? (
            `Add these ${MAX_CHOSEN} people first.`
          ) : search.pending ? (
            <>
              <Spinner
                aria-hidden="true"
                className="size-3.5"
                role={undefined}
              />
              Searching…
            </>
          ) : search.failed ? (
            "Search is unavailable."
          ) : (
            "No people match."
          )}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-end gap-2">
        <FieldError className="mr-auto min-w-0" id={errorId}>
          {failed.length > 0 ? `Could not add ${failed.join(", ")}.` : null}
        </FieldError>
        <Button
          disabled={chosen.length === 0 || adding}
          type="submit"
          variant="default"
        >
          {adding ? <Spinner aria-hidden="true" role={undefined} /> : null}
          {props.submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Search Users for the picker once typing pauses. */
function useUserSearch(target: PeoplePickerTarget, query: string) {
  const debounced = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const search = useQuery({
    enabled: debounced.length > 0,
    placeholderData: keepPreviousData,
    queryKey: [...userSearchKey(target), debounced],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        userSearchReportSchema,
        `/api/people/user-search?${new URLSearchParams({ ...target, q: debounced })}`,
        signal,
      ),
    staleTime: SEARCH_STALE_MS,
  });
  if (!query) return { failed: false, pending: false, users: [] };
  return {
    failed: search.isError,
    pending: debounced !== query || search.isFetching,
    users: search.data?.users ?? [],
  };
}
