import { describe, expect, test } from "bun:test";
import { parseToolResult } from "./client";

describe("parseToolResult", () => {
  test("parses JSON text content", () => {
    const result = parseToolResult("t", { content: [{ type: "text", text: '{"events":[]}' }] });
    expect(result).toEqual({ events: [] });
  });

  test("returns non-JSON text as-is", () => {
    expect(parseToolResult("t", { content: [{ type: "text", text: "hello" }] })).toBe("hello");
  });

  test("prefers structuredContent when present", () => {
    const result = parseToolResult("t", {
      content: [{ type: "text", text: "ignored" }],
      structuredContent: { ok: true },
    });
    expect(result).toEqual({ ok: true });
  });

  test("throws with the tool's message when isError is set", () => {
    expect(() =>
      parseToolResult("list-events", { isError: true, content: [{ type: "text", text: "auth expired" }] }),
    ).toThrow('MCP tool "list-events" failed: auth expired');
  });

  test("ignores non-text content blocks", () => {
    const result = parseToolResult("t", {
      content: [{ type: "image", data: "..." }, { type: "text", text: "[1]" }],
    });
    expect(result).toEqual([1]);
  });
});
