import { expect, it } from "vitest";
import { REEWORK_VERSION } from "@reework/core";

it("exports the reework version symbol", () => {
  expect(REEWORK_VERSION).toBeTypeOf("string");
});
