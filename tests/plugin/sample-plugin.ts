// A plugin written against the reework facade ONLY — it never imports
// `@earendil-works/pi-durable` directly. This is what shields it from churn.
import { definePlugin, section } from "@reework/core";

export const GreetingPlugin = definePlugin("greeting", () => ({
  sections: [section("preamble", () => "You greet the user warmly.", { tag: false })],
}));
