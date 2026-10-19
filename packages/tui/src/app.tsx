import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentEvent, Proposal } from "@reework/types";
import { TuiProtocolClient } from "./client.ts";
import { decideGateAnswer, type GateAnswer } from "./answer.ts";

export interface AgentTuiProps {
  baseUrl: string;
  conversationId: string;
}

const eventLabel = (event: AgentEvent): string => {
  switch (event.kind) {
    case "run_start":
      return `run started (${event.runId})`;
    case "run_end":
      return `run ended (${event.outcome})`;
    case "message_update":
      return event.text;
    case "tool_execution_start":
      return `tool: ${event.name} → ...`;
    case "tool_execution_end":
      return `tool ${event.callId} done`;
    default:
      return event.kind;
  }
};

/** The native TUI: renders the agent's live event stream and gate proposals. */
export function AgentTui({ baseUrl, conversationId }: AgentTuiProps) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [input, setInput] = useState("");
  const [outcome, setOutcome] = useState<string | undefined>();

  useEffect(() => {
    const client = new TuiProtocolClient({ baseUrl });
    let disconnect: (() => void) | undefined;
    void client
      .connect(conversationId, (batch) => setEvents((prev) => [...prev, ...batch]))
      .then((unsubscribe) => {
        disconnect = unsubscribe;
      });
    const refresh = async () => setProposals(await client.listProposals(conversationId));
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      disconnect?.();
      clearInterval(timer);
    };
  }, [baseUrl, conversationId]);

  const submit = async () => {
    if (!input.trim()) return;
    const client = new TuiProtocolClient({ baseUrl });
    const message = await client.submitInput(conversationId, input.trim());
    setInput("");
    setOutcome(typeof message.content === "string" ? message.content : "");
  };

  const answer = async (proposal: Proposal, optionId: string) => {
    const client = new TuiProtocolClient({ baseUrl });
    await client.submitDecision(conversationId, {
      proposalId: proposal.id,
      selectedOption: optionId,
      instruction: null,
    });
  };

  const answerGate = async (gateAnswer: GateAnswer) => {
    const client = new TuiProtocolClient({ baseUrl });
    if (gateAnswer.kind === "option") {
      await client.submitDecision(conversationId, {
        proposalId: gateAnswer.proposalId,
        selectedOption: gateAnswer.optionId,
        instruction: null,
      });
    } else {
      await client.submitDecision(conversationId, {
        proposalId: gateAnswer.proposalId,
        selectedOption: null,
        instruction: gateAnswer.instruction,
      });
    }
  };

  useInput((data, key) => {
    if (key.return) {
      // Enter: resolve the input against the open gates; otherwise send as a message.
      const gateAnswer = decideGateAnswer(input, proposals);
      if (gateAnswer) {
        void answerGate(gateAnswer);
        setInput("");
        return;
      }
      void submit();
      return;
    }
    if (key.escape) {
      setInput("");
      return;
    }
    // With an empty prompt, a key matching an open gate's option id answers it.
    if (input.length === 0 && proposals.length > 0) {
      const matched = proposals.find((p) => p.options.some((o) => o.id === data));
      if (matched) {
        void answer(matched, data);
        return;
      }
    }
    if (key.backspace) {
      setInput((s) => s.slice(0, -1));
      return;
    }
    setInput((s) => s + data);
  });

  return (
    <Box flexDirection="column">
      <Text bold>reework agent — conversation {conversationId}</Text>
      <Box flexDirection="column">
        {events.slice(-8).map((event, index) => (
          <Text key={index}>{eventLabel(event)}</Text>
        ))}
      </Box>
      {proposals.length > 0 ? (
        <Box flexDirection="column">
          <Text bold color="yellow">
            Open gates:
          </Text>
          {proposals.map((proposal) => (
            <Box key={proposal.id} flexDirection="column">
              <Text>{proposal.title}</Text>
              {proposal.options.map((option) => (
                <Text key={option.id}>
                  <Text color="cyan">[{option.id}]</Text> {option.label}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      ) : null}
      {outcome ? <Text color="green">{outcome}</Text> : null}
      <Text>&gt; {input}</Text>
    </Box>
  );
}
