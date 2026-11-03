import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { applyFrame, createClient, emptyView } from "@reework/client";
import type { ConversationView } from "@reework/client";
import type { Case, Proposal } from "@reework/types";
import { loadStartState, operatorAuthor, sendToAgent } from "./state.ts";
import type { StartState } from "./state.ts";
import type { LineStyle } from "./format.ts";
import { transcriptLines } from "./transcript.ts";
import type { TranscriptStyle } from "./transcript.ts";
import { statusText } from "./status.ts";
import { cardLines, paneLines } from "./card.ts";
import type { CardLine } from "./card.ts";
import { backspace, emptyLine, insert, move, recall } from "./editor.ts";
import type { LineState } from "./editor.ts";
import { HELP_LINES } from "./help.ts";

const LINE_COLORS: Record<LineStyle, string | undefined> = {
  title: "white",
  file: "gray",
  hunk: "cyan",
  added: "green",
  removed: "red",
  context: undefined,
  plain: undefined,
};

const CARD_COLORS: Record<CardLine["style"], string | undefined> = {
  title: "white",
  meta: "gray",
  attachment: "cyan",
  option: undefined,
  selected: "yellow",
  hint: "gray",
};

const TRANSCRIPT_COLORS: Record<TranscriptStyle, string | undefined> = {
  user: "cyan",
  assistant: undefined,
  tool: "gray",
  "tool-error": "red",
  dim: "gray",
};

export interface AgentTuiProps {
  baseUrl: string;
  /** The agent's API token. */
  token: string;
  /** Terminal rows to fit into. Default: the terminal's height. */
  rows?: number;
  /** How often the inbox is refreshed. Default 2000 ms. */
  pollMs?: number;
  /** How long a notice stays. Default 6000 ms. */
  noticeMs?: number;
}

type Focus = "input" | "proposal";
interface CardState {
  index: number;
  option: number;
  open: number;
  offset: number;
}
const closedCard: CardState = { index: 0, option: 0, open: -1, offset: 0 };

/**
 * The native TUI. The inbox lists what waits on the operator (open proposals across
 * every conversation) and the conversations; arrows and Enter open one. In a
 * conversation, typing always talks to the agent ("chat"); Tab focuses a proposal to
 * answer it ("answer"). `/help` lists every key.
 */
export function AgentTui({ baseUrl, token, rows, pollMs = 2000, noticeMs = 6000 }: AgentTuiProps) {
  const client = useMemo(() => createClient({ baseUrl, token }), [baseUrl, token]);
  const height = rows ?? process.stdout.rows ?? 30;
  const [start, setStart] = useState<StartState>({ inbox: [], cases: [], closed: false });
  const [attached, setAttached] = useState<string | undefined>();
  const [view, setView] = useState<ConversationView | undefined>();
  const [line, setLine] = useState<LineState>(emptyLine);
  const [history, setHistory] = useState<{ lines: string[]; position: number }>({
    lines: [],
    position: 0,
  });
  const [notice, setNotice] = useState<string | undefined>();
  const [now, setNow] = useState(() => Date.now());
  const [name, setName] = useState<string | undefined>();
  const [focus, setFocus] = useState<Focus>("input");
  const [card, setCard] = useState<CardState>(closedCard);
  const [selected, setSelected] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    void client.health().then(
      (health) => setName(health.name),
      () => setName(undefined),
    );
  }, [client]);

  const closed = start.closed;
  const refresh = useCallback(async () => {
    try {
      setStart(await loadStartState(client, { closed }));
    } catch {
      setNotice("cannot reach the agent — retrying");
    }
  }, [client, closed]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), noticeMs);
    return () => clearTimeout(timer);
  }, [notice, noticeMs]);

  useEffect(() => {
    setScroll(0);
    if (!attached) return setView(undefined);
    setView(emptyView(attached));
    let close: (() => void) | undefined;
    let cancelled = false;
    void client
      .watch(attached, (frame) =>
        setView((current) => applyFrame(current ?? emptyView(attached), frame)),
      )
      .then(
        (watch) => {
          if (cancelled) watch.close();
          else close = () => watch.close();
        },
        () => setNotice("cannot watch the conversation"),
      );
    return () => {
      cancelled = true;
      close?.();
    };
  }, [client, attached]);

  const conversation = start.cases.find((c) => c.id === attached);
  const gates: readonly Proposal[] = attached
    ? (view?.proposals ?? start.inbox.filter((p) => p.conversationId === attached))
    : start.inbox;
  const cardIndex = Math.min(card.index, gates.length - 1);
  const focusedGate = focus === "proposal" ? gates[cardIndex] : undefined;
  useEffect(() => {
    if (focus === "proposal" && gates.length === 0) setFocus("input");
  }, [focus, gates.length]);

  /** Inbox entries: every case in inbox order. */
  const entries = attached ? [] : start.cases.map((c) => ({ kind: "case" as const, case: c }));
  const chosen = Math.min(selected, Math.max(0, entries.length - 1));

  const open = (id: string, proposalId?: string) => {
    setAttached(id);
    setLine(emptyLine);
    if (proposalId === undefined) return setFocus("input");
    const index = start.inbox
      .filter((p) => p.conversationId === id)
      .findIndex((p) => p.id === proposalId);
    setCard({ ...closedCard, index: Math.max(0, index) });
    setFocus("proposal");
  };

  const run = async (text: string) => {
    if (text === "/help") return setHelp((shown) => !shown);
    if (text === ":i") return setAttached(undefined);
    if (text === ":closed") return setStart((s) => ({ ...s, closed: !s.closed }));
    const pick = /^:(\d+)$/.exec(text);
    if (pick) {
      const target = start.cases[Number(pick[1]) - 1];
      return target ? open(target.id) : setNotice(`no case ${pick[1]}`);
    }
    if (!attached) return setNotice("open a case first (↑↓ Enter, or :N)");
    if (text === ":files") {
      try {
        const files = await client.listFiles(attached);
        return setNotice(
          files.length === 0
            ? "no files in this case"
            : files
                .map((f, i) => `${i + 1}. ${f.name} (${f.mimeType}, ${f.size} bytes)`)
                .join(" · "),
        );
      } catch (error) {
        return setNotice(`failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const save = /^:save (\d+) (.+)$/.exec(text);
    if (save) {
      try {
        const files = await client.listFiles(attached);
        const file = files[Number(save[1]) - 1];
        if (!file) return setNotice(`no file ${save[1]}`);
        const { bytes } = await client.downloadFile(attached, file.id);
        const dir = save[2]!;
        mkdirSync(dir, { recursive: true });
        const path = join(dir, file.name);
        writeFileSync(path, bytes);
        return setNotice(`saved ${path}`);
      } catch (error) {
        return setNotice(`failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const op = /^:(close|wait|reopen)$/.exec(text);
    if (op) {
      const status = op[1] === "close" ? "closed" : op[1] === "wait" ? "waiting" : "open";
      try {
        await client.updateCase(attached, { status });
        setNotice(`case ${status}`);
        void refresh();
      } catch (error) {
        setNotice(`failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const prio = /^:priority (low|normal|high|urgent)$/.exec(text);
    if (prio) {
      try {
        await client.updateCase(attached, { priority: prio[1] as "low" });
        setNotice(`priority ${prio[1]}`);
        void refresh();
      } catch (error) {
        setNotice(`failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (text === ":dismiss") {
      const target = focusedGate ?? gates[0];
      if (!target) return setNotice("no open proposal to dismiss");
      try {
        await client.decide(
          {
            proposalId: target.id,
            selectedOption: null,
            instruction: null,
            decidedBy: operatorAuthor(),
          },
          { conversationId: target.conversationId },
        );
        setNotice("proposal dismissed");
        void refresh();
      } catch (error) {
        setNotice(`failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    setHistory((h) => ({ lines: [...h.lines, text], position: h.lines.length + 1 }));
    setScroll(0);
    await sendToAgent(client, attached, text);
  };

  /** Answer the focused proposal: the highlighted option, or the typed instruction. */
  const decide = async (proposal: Proposal, text: string) => {
    if (text && !proposal.acceptFreeForm) {
      return setNotice("This proposal takes only its options: pick one with ↑↓ and Enter.");
    }
    const option = proposal.options[card.option];
    if (!text && !option) return;
    await client.decide(
      text
        ? {
            proposalId: proposal.id,
            selectedOption: null,
            instruction: text,
            decidedBy: operatorAuthor(),
          }
        : {
            proposalId: proposal.id,
            selectedOption: option!.id,
            instruction: null,
            decidedBy: operatorAuthor(),
          },
      { conversationId: proposal.conversationId },
    );
    setFocus("input");
    setCard(closedCard);
    setNotice(
      text
        ? `Instruction sent to the agent (proposal: ${proposal.title}).`
        : `Chose "${option!.label}" (proposal: ${proposal.title}).`,
    );
    void refresh();
  };

  // Layout: header, waiting line, cards, [pane], transcript or lists, status, notice, input, footer.
  const fixed = 6;
  const cardFocusOf = (index: number) => {
    const focused = focus === "proposal" && index === cardIndex;
    return { focused, option: card.option, open: focused ? card.open : -1 };
  };
  const cards = gates.map((p, i) => cardLines(p, cardFocusOf(i)));
  const cardHeight = cards.reduce((n, c) => n + c.length, gates.length > 0 ? 1 : 0);
  // The pane's top and bottom border take two rows; the transcript keeps at least two.
  const paneHeight = Math.max(3, height - fixed - cardHeight - 2 - 2);
  const pane =
    focusedGate && card.open >= 0
      ? paneLines(focusedGate, card.open, card.offset, paneHeight)
      : undefined;
  const lines = view ? transcriptLines(view, now) : [];
  const room = Math.max(
    pane ? 0 : 1,
    height - fixed - cardHeight - (pane ? pane.lines.length + 2 : 0),
  );
  const maxScroll = Math.max(0, lines.length - room);
  const offset = Math.min(scroll, maxScroll);
  const visible = lines.slice(Math.max(0, lines.length - room - offset), lines.length - offset);

  useInput((data, key) => {
    const failed = (error: unknown) =>
      setNotice(`failed: ${error instanceof Error ? error.message : String(error)}`);

    if (help && key.escape) return setHelp(false);

    if (key.tab) {
      if (gates.length === 0) return;
      if (focus === "input") {
        setCard(closedCard);
        return setFocus("proposal");
      }
      if (cardIndex + 1 < gates.length) return setCard({ ...closedCard, index: cardIndex + 1 });
      return setFocus("input");
    }

    if (focus === "proposal" && focusedGate) {
      const attachments = focusedGate.attachments?.length ?? 0;
      if (key.rightArrow && attachments > 0) {
        return setCard({ ...card, open: (card.open + 1) % attachments, offset: 0 });
      }
      if ((key.leftArrow || key.escape) && card.open >= 0) return setCard({ ...card, open: -1 });
      if (key.escape) return setFocus("input");
      if (card.open >= 0 && pane) {
        const step = key.pageDown
          ? paneHeight
          : key.pageUp
            ? -paneHeight
            : key.downArrow
              ? 1
              : key.upArrow
                ? -1
                : 0;
        if (step !== 0) {
          const max = Math.max(0, pane.total - paneHeight);
          return setCard({ ...card, offset: Math.min(max, Math.max(0, pane.offset + step)) });
        }
      }
      if (key.downArrow) {
        return setCard({
          ...card,
          option: Math.min(focusedGate.options.length - 1, card.option + 1),
        });
      }
      if (key.upArrow) return setCard({ ...card, option: Math.max(0, card.option - 1) });
      if (key.return) {
        const text = line.text.trim();
        setLine(emptyLine);
        return void decide(focusedGate, text).catch(failed);
      }
    } else {
      // Chat focus.
      if (!attached && line.text === "") {
        if (key.downArrow) return setSelected(Math.min(entries.length - 1, chosen + 1));
        if (key.upArrow) return setSelected(Math.max(0, chosen - 1));
        if (key.return) {
          const entry = entries[chosen];
          if (!entry) return;
          return open(entry.case.id);
        }
      }
      if (attached) {
        if (key.escape && line.text === "") return setAttached(undefined);
        if (key.pageUp) return setScroll(Math.min(maxScroll, offset + Math.max(1, room - 1)));
        if (key.pageDown) return setScroll(Math.max(0, offset - Math.max(1, room - 1)));
        if (key.upArrow || key.downArrow) {
          const next = recall(history.lines, history.position, key.upArrow ? -1 : 1);
          setHistory((h) => ({ ...h, position: next.position }));
          return setLine(next.line);
        }
      }
      if (key.return) {
        const text = line.text.trim();
        setLine(emptyLine);
        if (text) void run(text).catch(failed);
        return;
      }
    }

    if (key.escape) return setLine(emptyLine);
    if (key.leftArrow) return setLine((l) => move(l, -1));
    if (key.rightArrow) return setLine((l) => move(l, 1));
    if (key.backspace || key.delete) return setLine((l) => backspace(l));
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.ctrl || key.meta) return;
    if (data) setLine((l) => insert(l, data));
  });

  return (
    <Box flexDirection="column">
      <Text bold>
        reework — {attached ? `conversation ${conversation?.key ?? attached}` : "inbox"}
      </Text>
      {help ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          {HELP_LINES.map((text, i) => (
            <Text key={i} bold={i === 0}>
              {text}
            </Text>
          ))}
        </Box>
      ) : null}
      {gates.length > 0 ? (
        <Text bold color="yellow">
          Waiting on you ({gates.length})
        </Text>
      ) : null}
      {gates.map((proposal, index) => {
        const highlighted = !attached && chosen === index && focus === "input";
        return (
          <Box key={proposal.id} flexDirection="column" marginLeft={1}>
            {cards[index]!.map((cardLine, l) => (
              <Text
                key={l}
                bold={cardLine.style === "title" || cardLine.style === "selected"}
                color={CARD_COLORS[cardLine.style]}
              >
                {l === 0 && highlighted ? `› ${cardLine.text}` : cardLine.text}
              </Text>
            ))}
          </Box>
        );
      })}
      {pane ? (
        <Box flexDirection="column" borderStyle="single" borderLeft={false} borderRight={false}>
          {pane.lines.map((paneLine, l) => (
            <Text key={l} color={LINE_COLORS[paneLine.style]}>
              {paneLine.text}
            </Text>
          ))}
        </Box>
      ) : null}
      {attached ? (
        <Box flexDirection="column">
          {conversation ? (
            <Text bold color="magenta">
              {caseLine(conversation)}
            </Text>
          ) : null}
          {visible.map((transcriptLine, index) => (
            <Text key={index} color={TRANSCRIPT_COLORS[transcriptLine.style]}>
              {transcriptLine.text}
            </Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text bold>Cases{start.closed ? " (including closed)" : ""}</Text>
          {start.cases.map((c, index) => {
            const highlighted = chosen === index;
            return (
              <Text key={c.id} color={highlighted ? "yellow" : undefined}>
                {highlighted ? "›" : " "} <Text color="cyan">:{index + 1}</Text> {caseLine(c)}
              </Text>
            );
          })}
        </Box>
      )}
      <Text inverse>
        {` ${statusText(name, attached ? (conversation?.key ?? attached) : undefined, view, now)}${offset > 0 ? ` · scrolled up ${offset}` : ""} `}
      </Text>
      {notice ? <Text color="green">{notice}</Text> : null}
      <Text>
        <Text color={focus === "proposal" ? "yellow" : "cyan"}>
          {focus === "proposal" ? "answer" : "chat"}
        </Text>
        &gt; {line.text.slice(0, line.cursor)}
        <Text inverse>{line.text[line.cursor] ?? " "}</Text>
        {line.text.slice(line.cursor + 1)}
      </Text>
      <Text dimColor>{footerHint(focus, Boolean(attached), gates.length > 0)}</Text>
    </Box>
  );
}

function caseLine(c: Case): string {
  const name = c.title ?? c.key ?? c.id;
  const bits = [name];
  if (c.stage) bits.push(c.stage);
  bits.push(c.priority);
  if (c.dueAt !== undefined) bits.push(new Date(c.dueAt).toISOString().slice(0, 10));
  if (c.openProposals > 0)
    bits.push(`${c.openProposals} proposal${c.openProposals > 1 ? "s" : ""}`);
  return bits.join(" · ");
}

function footerHint(focus: Focus, attached: boolean, proposals: boolean): string {
  if (focus === "proposal") {
    return "answer mode: ↑↓ option · Enter decide · type an instruction · → attachment · Esc back";
  }
  const tab = proposals ? " · Tab answer a proposal" : "";
  return attached
    ? `chat mode: Enter sends to the agent${tab} · PgUp/PgDn scroll · Esc inbox · /help`
    : `chat mode: ↑↓ Enter open${tab} · /help`;
}
