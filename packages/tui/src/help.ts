// What `/help` shows.
export const HELP_LINES: readonly string[] = [
  "Keys",
  "Inbox        ↑↓ select · Enter open a case · :N open case N · :closed show closed cases",
  "Chat         type + Enter talks to the agent · ↑↓ recall sent lines · ←→ move the cursor",
  "             PgUp/PgDn scroll the transcript · Esc back to the inbox · :i inbox",
  "Proposals    Tab focus the next proposal (answer mode) · ↑↓ option · Enter decide",
  "             type + Enter sends an instruction (when accepted) · → open the next attachment",
  "             PgUp/PgDn scroll it · ← or Esc fold it · Esc again back to chat",
  "Operate      :close :wait :reopen · :priority high · :dismiss a proposal",
  "Files        :files lists this case's files · :save N <dir> writes file N there",
  "Help         /help toggles this · Esc closes it",
];
