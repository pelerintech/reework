import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { createClient } from "@reework/client";
import type { WatchFrame } from "@reework/client";
import type { AgentEvent, Proposal } from "@reework/types";
import { decideGateAnswer } from "./answer.ts";
import { answerProposal, loadStartState, sendToAgent } from "./state.ts";
import { formatAttachment } from "./format.ts";
import type { LineStyle } from "./format.ts";

const LINE_COLORS: Record<LineStyle, string | undefined> = {
  title: "white",
  file: "gray",
  hunk: "cyan",
  added: "green",
  removed: "red",
  context: undefined,
  plain: undefined,
};
import type { StartState } from "./state.ts";

export interface AgentTuiProps {
  baseUrl: string;
  /** The agent's API token. */
  token: string;
}

const eventLabel = (event: AgentEvent): string => {
  switch (event.kind) {
    case "run_start":
      return "run started";
    case "run_end":
      return `run ended (${event.outcome})`;
    case "message_update":
      return event.text;
    case "tool_execution_start":
      return `tool: ${event.name}`;
    case "tool_execution_end":
      return `tool done`;
    default:
      return event.kind;
  }
};

/**
 * The native TUI. It opens on the inbox (open proposals across every
 * conversation) and the conversation list; `:N` attaches to conversation N,
 * `:i` returns to the inbox. With a conversation attached, text goes to the
 * agent, and an option id or free text answers that conversation's gate.
 */
export function AgentTui({ baseUrl, token }: AgentTuiProps) {
  const client = useMemo(() => createClient({ baseUrl, token }), [baseUrl, token]);
  const [start, setStart] = useState<StartState>({ inbox: [], conversations: [] });
  const [attached, setAttached] = useState<string | undefined>();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState<string | undefined>();

  const refresh = useCallback(async () => setStart(await loadStartState(client)), [client]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!attached) return;
    setEvents([]);
    let close: (() => void) | undefined;
    void client
      .watch(attached, (frame: WatchFrame) => {
        if (frame.kind === "events") setEvents((prev) => [...prev, ...frame.events]);
      })
      .then((watch) => {
        close = () => watch.close();
      });
    return () => close?.();
  }, [client, attached]);

  const gates: Proposal[] = attached
    ? start.inbox.filter((p) => p.conversationId === attached)
    : [...start.inbox];

  const run = async (line: string) => {
    if (line === ":i") return setAttached(undefined);
    const pick = /^:(\d+)$/.exec(line);
    if (pick) {
      const conversation = start.conversations[Number(pick[1]) - 1];
      return conversation ? setAttached(conversation.id) : setNotice(`no conversation ${pick[1]}`);
    }
    const target = decideGateAnswer(line, gates);
    const proposal = target && gates.find((p) => p.id === target.proposalId);
    if (proposal && (await answerProposal(client, proposal, line))) {
      setNotice(
        `Your answer was sent to the agent (proposal: ${proposal.title}). Nothing is carried out unless you chose an action option.`,
      );
      return refresh();
    }
    if (!attached) return setNotice("attach to a conversation (:N) to talk to the agent");
    await sendToAgent(client, attached, line);
    setNotice("sent — the answer will stream in");
  };

  useInput((data, key) => {
    if (key.return) {
      const line = input.trim();
      setInput("");
      if (line) void run(line);
      return;
    }
    if (key.escape) return setInput("");
    if (key.backspace || key.delete) return setInput((s) => s.slice(0, -1));
    setInput((s) => s + data);
  });

  return (
    <Box flexDirection="column">
      <Text bold>reework — {attached ? `conversation ${attached}` : "inbox"}</Text>
      <Text bold color="yellow">
        Waiting on you ({gates.length})
      </Text>
      {gates.map((proposal) => (
        <Box key={proposal.id} flexDirection="column" marginLeft={1}>
          <Text>
            {proposal.title} <Text dimColor>· conversation {proposal.conversationId}</Text>
          </Text>
          {(proposal.attachments ?? []).flatMap((attachment, a) =>
            formatAttachment(attachment).map((line, l) => (
              <Text key={`${a}-${l}`} color={LINE_COLORS[line.style]} bold={line.style === "title"}>
                {line.text}
              </Text>
            )),
          )}
          {proposal.options.map((option) => (
            <Text key={option.id}>
              <Text color="cyan">[{option.id}]</Text> {option.label}
            </Text>
          ))}
          {proposal.acceptFreeForm ? <Text dimColor>or type an instruction</Text> : null}
        </Box>
      ))}
      {attached ? (
        <Box flexDirection="column">
          {events.slice(-8).map((event, index) => (
            <Text key={index}>{eventLabel(event)}</Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text bold>Conversations</Text>
          {start.conversations.map((conversation, index) => (
            <Text key={conversation.id}>
              <Text color="cyan">:{index + 1}</Text> {conversation.key ?? conversation.id}
            </Text>
          ))}
        </Box>
      )}
      {notice ? <Text color="green">{notice}</Text> : null}
      <Text>&gt; {input}</Text>
    </Box>
  );
}
