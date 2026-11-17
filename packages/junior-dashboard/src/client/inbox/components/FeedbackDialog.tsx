import { useId, useState } from "react";

import { getDashboardAgentName } from "../../agentName";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Field,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../components/ui/field";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import { Textarea } from "../../components/ui/textarea";
import { useToastManager } from "../../components/ui/toast";
import { useSheet } from "../../components/ui/useSheet";
import { sendFeedback, type FeedbackTopic } from "../../sentry";
import type { Identity } from "../../types";

/**
 * Ask what the feedback is about and for a comment, then send it as Sentry
 * user feedback, like a Reply rating. No topic is chosen at first, so each
 * feedback names one on purpose.
 */
export function FeedbackDialog(props: {
  onClose(): void;
  reader: Identity["user"];
}) {
  const commentId = useId();
  const topicId = useId();
  const [topic, setTopic] = useState<FeedbackTopic | null>(null);
  const [comment, setComment] = useState("");
  const sheet = useSheet(props.onClose);
  const toast = useToastManager();
  const text = comment.trim();
  const topics: [FeedbackTopic, string][] = [
    ["agent", `${getDashboardAgentName()} in general`],
    ["new_ui", "The new UI"],
  ];
  return (
    <Dialog {...sheet.rootProps}>
      <DialogContent {...sheet.contentProps}>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!topic || !text) return;
            sendFeedback({
              comment: text,
              kind: "general",
              reader: props.reader,
              topic,
            });
            toast.add({ title: "Feedback sent", type: "success" });
            sheet.close();
          }}
        >
          <DialogTitle>Send feedback</DialogTitle>
          <FieldSet className="gap-0">
            <FieldLegend id={topicId} variant="label">
              About
            </FieldLegend>
            <RadioGroup<FeedbackTopic | null>
              aria-labelledby={topicId}
              className="grid gap-1.5"
              onValueChange={setTopic}
              value={topic}
            >
              {topics.map(([value, label]) => (
                <Field key={value} orientation="horizontal">
                  <RadioGroupItem id={`${topicId}-${value}`} value={value} />
                  <FieldLabel
                    className="font-normal"
                    htmlFor={`${topicId}-${value}`}
                  >
                    {label}
                  </FieldLabel>
                </Field>
              ))}
            </RadioGroup>
          </FieldSet>
          <Field>
            <FieldLabel htmlFor={commentId}>Comment</FieldLabel>
            <Textarea
              id={commentId}
              className="min-h-28"
              onChange={(event) => setComment(event.target.value)}
              value={comment}
            />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button disabled={!topic || !text} type="submit" variant="default">
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
