/** Render the compact monochrome Slack mark used for transcript source metadata. */
export function SlackMark(props: { className?: string }) {
  return (
    <svg
      aria-label="Slack"
      className={props.className}
      fill="currentColor"
      role="img"
      viewBox="0 0 24 24"
    >
      <path d="M6.2 15.3c0 1.4-1.1 2.5-2.5 2.5S1.2 16.7 1.2 15.3s1.1-2.5 2.5-2.5h2.5v2.5zm1.3 0c0-1.4 1.1-2.5 2.5-2.5s2.5 1.1 2.5 2.5v6.2c0 1.4-1.1 2.5-2.5 2.5s-2.5-1.1-2.5-2.5v-6.2zM8.7 6.2c-1.4 0-2.5-1.1-2.5-2.5S7.3 1.2 8.7 1.2s2.5 1.1 2.5 2.5v2.5H8.7zm0 1.3c1.4 0 2.5 1.1 2.5 2.5s-1.1 2.5-2.5 2.5H2.5C1.1 12.5 0 11.4 0 10s1.1-2.5 2.5-2.5h6.2zM17.8 8.7c0-1.4 1.1-2.5 2.5-2.5s2.5 1.1 2.5 2.5-1.1 2.5-2.5 2.5h-2.5V8.7zm-1.3 0c0 1.4-1.1 2.5-2.5 2.5s-2.5-1.1-2.5-2.5V2.5C11.5 1.1 12.6 0 14 0s2.5 1.1 2.5 2.5v6.2zM14 17.8c1.4 0 2.5 1.1 2.5 2.5s-1.1 2.5-2.5 2.5-2.5-1.1-2.5-2.5v-2.5H14zm0-1.3c-1.4 0-2.5-1.1-2.5-2.5s1.1-2.5 2.5-2.5h6.2c1.4 0 2.5 1.1 2.5 2.5s-1.1 2.5-2.5 2.5H14z" />
    </svg>
  );
}
