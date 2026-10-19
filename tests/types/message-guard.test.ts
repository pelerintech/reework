import { describe, expect, it } from "vitest";
import { isMessage } from "@reework/types";
import type { Message } from "@reework/types";

describe("shared Message type and isMessage guard", () => {
  it("validates a pi-ai-style message ({ role, content })", () => {
    expect(isMessage({ role: "user", content: "hi", timestamp: 1 })).toBe(true);
    expect(
      isMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 1 }),
    ).toBe(true);
  });

  it("rejects non-message values", () => {
    expect(isMessage({ role: "user" })).toBe(false);
    expect(isMessage({ content: "hi" })).toBe(false);
    expect(isMessage(null)).toBe(false);
    expect(isMessage("hi")).toBe(false);
  });

  it("is importable and assignable as a type", () => {
    const m: Message = { role: "user", content: "hello", timestamp: 1 };
    expect(m.role).toBe("user");
  });
});
