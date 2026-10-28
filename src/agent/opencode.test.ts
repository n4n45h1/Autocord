import { describe, expect, it } from "vitest";
import { extractPlanJson } from "./opencode.js";

describe("OpenCode structured response extraction", () => {
  it("extracts a balanced final object after prose and malformed brace examples", () => {
    expect(extractPlanJson('Example {not json}. Result: {"workflow":{"description":"a } brace"},"target":"interactive"}'))
      .toEqual({ workflow: { description: "a } brace" }, target: "interactive" });
  });

  it("prefers valid fenced JSON and rejects responses without an object", () => {
    expect(extractPlanJson('Here is the result:\n```json\n{"target":"panel"}\n```')).toEqual({ target: "panel" });
    expect(() => extractPlanJson("No JSON here.")).toThrow("did not contain a JSON object");
  });
});
