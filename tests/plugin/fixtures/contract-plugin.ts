// A fixture plugin that must type-check against the built `dist` declarations
// using only `@reework/core`: tools, hooks, a named model, and the case, files,
// store and once members of the context.
import { Type, definePlugin, defineTool } from "@reework/core";
import type { ToolContext } from "@reework/core";

export const demo = definePlugin(
  "demo",
  () => ({
    tools: [
      defineTool({
        name: "ping",
        description: "Answer.",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute(_args, ctx: ToolContext) {
          const current = await ctx.case.get();
          const files = await ctx.files.list();
          const pings = (await ctx.store.agent.get<number>("pings")) ?? 0;
          await ctx.store.agent.set("pings", pings + 1);
          const once = await ctx.once("ping", async () => pings);
          const answer = await ctx.models.complete("fast", { messages: "ping" });
          return `pong:${ctx.conversationId}:${current.status}:${files.length}:${pings}:${once}:${answer.text}`;
        },
      }),
    ],
    hooks: {
      async beforeTool({ name }, ctx) {
        await ctx.memo("seen", async () => name);
        await ctx.case.get();
        await ctx.files.list();
        await ctx.store.case.set("lastTool", name);
      },
    },
  }),
  { models: ["fast"] },
);
