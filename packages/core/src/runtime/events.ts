// The per-agent event-hook dispatcher: host-level moments (input, decisions, case
// lifecycle) reach plugins through one FIFO queue, one event at a time, in
// declaration order. The caller never waits; delivery is at most once.
import type { PluginEventContext, PluginHooks } from "../tooling/facade.ts";

/** The host-level moments plugins can hook. */
export type EventHookName =
  | "onInput"
  | "onProposalOpened"
  | "onDecision"
  | "onCaseClosed"
  | "onCaseReopened"
  | "onModelUsage"
  | "onSecretUse";

/** One plugin's event hooks, with its name for logging. */
export interface EventHookPlugin {
  readonly name: string;
  readonly hooks: PluginHooks;
}

interface QueuedEvent {
  readonly hook: EventHookName;
  /** Absent for an agent-level event (a model call outside a conversation). */
  readonly conversationId?: string;
  readonly input: unknown;
}

export class EventDispatcher {
  private readonly queue: QueuedEvent[] = [];
  private readonly plugins: readonly EventHookPlugin[];
  /** Build the context one plugin receives for one conversation (agent-level without one). */
  private readonly context: (plugin: string, conversationId?: string) => PluginEventContext;
  /** Aborted when the agent begins to stop; no new events are queued afterwards. */
  private readonly signal: AbortSignal;
  private active?: Promise<void>;

  constructor(
    plugins: readonly EventHookPlugin[],
    context: (plugin: string, conversationId?: string) => PluginEventContext,
    signal: AbortSignal,
  ) {
    this.plugins = plugins;
    this.context = context;
    this.signal = signal;
  }

  /** Queue an event; the caller returns at once. Dropped once stopping began. */
  enqueue(hook: EventHookName, conversationId: string | undefined, input: unknown): void {
    if (this.signal.aborted) return;
    this.queue.push({ hook, conversationId, input });
    this.start();
  }

  /** Await every queued and running event hook. */
  async drain(): Promise<void> {
    for (;;) {
      const running = this.active;
      if (running) {
        await running;
        continue;
      }
      if (this.queue.length === 0) return;
      this.start();
    }
  }

  private start(): void {
    if (this.active) return;
    this.active = this.runLoop().finally(() => {
      this.active = undefined;
      // An event queued as the loop was ending must not wait for the next one.
      if (this.queue.length > 0) this.start();
    });
  }

  private async runLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const event = this.queue.shift()!;
      await this.deliver(event);
    }
  }

  private async deliver(event: QueuedEvent): Promise<void> {
    for (const plugin of this.plugins) {
      const hook = (plugin.hooks as Record<string, unknown>)[event.hook];
      if (!hook) continue;
      try {
        await (hook as (input: unknown, ctx: PluginEventContext) => Promise<void>)(
          event.input,
          this.context(plugin.name, event.conversationId),
        );
      } catch (error) {
        console.error(`[reework] plugin "${plugin.name}" ${event.hook} hook threw:`, error);
      }
    }
  }
}
