import { describe, expect, it } from "vitest";
import { defineAgent } from "@reework/core";

describe("defineAgent produces a plain, inspectable definition", () => {
  it("returns an object whose model.provider carries the custom endpoint", () => {
    const agent = defineAgent({
      name: "oncall",
      model: {
        provider: { baseUrl: "https://llm.example.com/v1", apiKey: "secret" },
        modelId: "oncall-1",
      },
      plugins: [],
      channels: [],
      mission: {
        role: "You are the on-call engineer.",
        tools: ["otel.query", "app.api"],
      },
    });

    expect(typeof agent).toBe("object");
    expect(agent).not.toBeNull();
    expect(agent.name).toBe("oncall");
    expect(agent.model.provider.baseUrl).toBe("https://llm.example.com/v1");
    expect(agent.model.provider.apiKey).toBe("secret");
    expect(agent.model.modelId).toBe("oncall-1");
  });

  it("retains each declared plugin and channel as an installed package with a distinct config", () => {
    const skillsPlugin = { install() {} };
    const whatsappChannel = { id: "whatsapp" };
    const webChannel = { id: "web" };

    const agent = defineAgent({
      name: "oncall",
      model: { provider: { baseUrl: "u", apiKey: "k" }, modelId: "m" },
      plugins: [{ plugin: skillsPlugin, config: { dir: "./skills" } }],
      channels: [
        { plugin: whatsappChannel, config: { token: "t" } },
        { plugin: webChannel, config: { port: 3000 } },
      ],
      mission: { role: "r", tools: [] },
    });

    expect(agent.plugins).toHaveLength(1);
    expect(agent.plugins[0].plugin).toBe(skillsPlugin);
    expect(agent.plugins[0].config).toEqual({ dir: "./skills" });

    expect(agent.channels).toHaveLength(2);
    expect(agent.channels[0].plugin).toBe(whatsappChannel);
    expect(agent.channels[0].config).toEqual({ token: "t" });
    expect(agent.channels[1].plugin).toBe(webChannel);
    expect(agent.channels[1].config).toEqual({ port: 3000 });
  });
});
