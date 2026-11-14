import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type EventLogShownValue = { setShown(shown: boolean): void; shown: boolean };

const EventLogShownContext = createContext<EventLogShownValue | null>(null);

/** Hold whether a Conversation shows its event log, for the palette. */
export function EventLogShownProvider(props: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  const value = useMemo(() => ({ setShown, shown }), [shown]);
  return (
    <EventLogShownContext.Provider value={value}>
      {props.children}
    </EventLogShownContext.Provider>
  );
}

/** Tell the palette that the event log shows, so its Events rank first. */
export function useReportEventLogShown(shown: boolean) {
  const setShown = useContext(EventLogShownContext)?.setShown;
  useEffect(() => {
    setShown?.(shown);
    return () => setShown?.(false);
  }, [setShown, shown]);
}

/** True while a Conversation shows its event log. */
export function useEventLogShown(): boolean {
  return useContext(EventLogShownContext)?.shown ?? false;
}
