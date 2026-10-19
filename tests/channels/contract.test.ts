import { describe, expect, it } from "vitest";
import { isChannel } from "@reework/types";
import type { Channel, ChannelRestContract, ChannelWsContract } from "@reework/types";

describe("Channel contract has separate REST and WS transport surfaces", () => {
  it("exposes distinct REST and WS contracts on the Channel type", () => {
    const channel: Channel = {
      id: "web",
      rest: {
        sendMessage: async () => ({ conversationId: "c", result: "ok" }),
        getConversation: async () => ({ id: "c", entries: [] }),
      } satisfies ChannelRestContract,
      ws: {
        watchEvents: async () => ({ snapshot: { events: [] }, start: async () => {} }),
      } satisfies ChannelWsContract,
    } as Channel;
    expect(isChannel(channel)).toBe(true);
    expect(channel.rest).toBeDefined();
    expect(channel.ws).toBeDefined();
    // REST and WS are separate surfaces, not the same object.
    expect(channel.rest).not.toBe(channel.ws);
  });
});
