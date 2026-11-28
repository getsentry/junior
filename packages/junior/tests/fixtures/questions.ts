/**
 * `askUserQuestion` input for one question with two choices, Yes and No,
 * that asks `text`. Its stored item has `text` as its title and body.
 */
export function ask(text: string, header = "Decision") {
  return [
    {
      question: text,
      header,
      options: [
        { label: "Yes", description: "Go ahead." },
        { label: "No", description: "Stop here." },
      ],
    },
  ];
}
