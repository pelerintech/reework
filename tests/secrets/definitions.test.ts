// Secret definitions are validated at startup: a missing local source fails
// before the agent opens, naming the secret.
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent, testDefinition } from "../support/agent.ts";

const MISSING_ENV = "REEWORK_TEST_MISSING_SECRET";

afterEach(() => {
  delete process.env[MISSING_ENV];
});

function definition(secrets: AgentDefinition["secrets"]): AgentDefinition {
  return testDefinition({ secrets });
}

describe("secret definitions: startup validation", () => {
  it("fails naming a secret whose environment variable is missing", async () => {
    delete process.env[MISSING_ENV];
    await expect(
      startTestAgent(
        definition({
          brave: {
            from: `env:${MISSING_ENV}`,
            apply: { header: "X-Subscription-Token" },
            hosts: ["127.0.0.1"],
          },
        }),
      ),
    ).rejects.toThrow(/secret "brave"/);
  });
});
