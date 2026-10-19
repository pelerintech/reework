import type {
  AgentEventStream,
  Channel,
  ConversationSummary,
  InboundMessage,
  SendMessageResult,
} from "@reework/types";
import { CONTEXT } from "../engine.ts";
import type { Engine } from "../engine.ts";

/**
 * WhatsApp channel. Satisfies the same `Channel` contract as the web channel.
 * In v01 the WhatsApp *transport* is stubbed behind the contract (real
 * transport SDK deferred); the channel still routes a message to the engine.
 */
export class WhatsAppChannel implements Channel {
  readonly id = "whatsapp";

  constructor(private readonly engine: Engine) {}

  readonly rest = {
    sendMessage: async (input: InboundMessage): Promise<SendMessageResult> => {
      const result = await this.engine.run(input.text);
      return { conversationId: input.conversationId, result };
    },
    getConversation: async (id: string): Promise<ConversationSummary> => {
      const root = await this.engine.root();
      return {
        id,
        entries: [...(await root.entries({ order: "descending" }, 50, undefined, CONTEXT)).items],
      };
    },
  };

  readonly ws = {
    watchEvents: async (): Promise<AgentEventStream> => {
      // Stubbed transport: no live transport in v01.
      return {
        snapshot: { events: [] },
        start: async () => {},
      };
    },
  };
}
