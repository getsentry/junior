import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "../../components/ui/field";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import {
  useTranscriptScroller,
  type TranscriptScroller,
} from "../../conversations/transcriptScroller";
import { SettingFrame, type SettingFrameKind } from "./SettingFrame";

const scrollerOptions: {
  description: string;
  label: string;
  value: TranscriptScroller;
}[] = [
  {
    description: "Show the browser scrollbar.",
    label: "Scrollbar",
    value: "scrollbar",
  },
  {
    description:
      "Hide the scrollbar where the outline shows. The outline marks the messages on screen. Drag along it to move through the whole conversation.",
    label: "Outline",
    value: "outline",
  },
];

/**
 * Let the user choose what scrolls a transcript on this browser. Phones skip
 * it: the outline shows only beside a wide transcript.
 */
export function TranscriptScrollerSetting(props: { frame?: SettingFrameKind }) {
  const [scroller, setScroller] = useTranscriptScroller();
  return (
    <SettingFrame
      anchor="scroll-conversations-with"
      className="hidden md:block"
      frame={props.frame}
      title="Scroll conversations with"
    >
      <RadioGroup<TranscriptScroller>
        aria-label="Scroll conversations with"
        className="mt-4 grid gap-3"
        onValueChange={setScroller}
        value={scroller}
      >
        {scrollerOptions.map((option) => (
          <Field key={option.value} orientation="horizontal">
            <RadioGroupItem
              aria-describedby={`transcript-scroller-${option.value}-help`}
              id={`transcript-scroller-${option.value}`}
              value={option.value}
            />
            <FieldContent>
              <FieldLabel htmlFor={`transcript-scroller-${option.value}`}>
                {option.label}
              </FieldLabel>
              <FieldDescription id={`transcript-scroller-${option.value}-help`}>
                {option.description}
              </FieldDescription>
            </FieldContent>
          </Field>
        ))}
      </RadioGroup>
    </SettingFrame>
  );
}
