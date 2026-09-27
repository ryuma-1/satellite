import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import { z } from "zod";
import type { SkillMeta } from "../skills/registry";
import { createSkillTools } from "./skill_tools";

/**
 * Minimal execution options; the tool under test does not use them.
 */
const execOptions = { toolCallId: "call1", messages: [] } as unknown as ToolExecutionOptions<never>;

/**
 * Invokes load_skill's execute function, failing the test if it is missing.
 */
async function loadSkill(tools: ReturnType<typeof createSkillTools>, input: unknown): Promise<unknown> {
  const execute = tools.load_skill?.execute;
  if (!execute) throw new Error("tool load_skill has no execute");
  return await execute(input as never, execOptions);
}

/** A single discovered Skill's metadata, shared across the tests below. */
const taskCreation: SkillMeta = { name: "task-creation", description: "タスク作成を依頼されたときに使用する" };

describe("createSkillTools", () => {
  test("load_skill returns the body from loadBody for a known skill", async () => {
    const tools = createSkillTools([taskCreation], async (name) => `body of ${name}`);

    const result = await loadSkill(tools, { name: "task-creation" });

    expect(result).toBe("body of task-creation");
  });

  test("load_skill's inputSchema restricts name to the discovered skills", () => {
    const tools = createSkillTools([taskCreation], async (name) => name);
    const schema = tools.load_skill?.inputSchema;
    const properties = (z.toJSONSchema(schema as z.ZodType) as { properties: Record<string, unknown> }).properties;
    expect(properties.name).toMatchObject({ enum: ["task-creation"] });
  });

  test("with no skills discovered, name falls back to a plain string instead of an invalid empty enum", () => {
    const tools = createSkillTools([], async (name) => name);
    const schema = tools.load_skill?.inputSchema;
    const properties = (z.toJSONSchema(schema as z.ZodType) as { properties: Record<string, unknown> }).properties;
    expect(properties.name).not.toHaveProperty("enum");
  });

  test("propagates loadBody's rejection for a name outside the discovered list", async () => {
    const tools = createSkillTools([], async (name) => {
      throw new Error(`Unknown skill "${name}"`);
    });

    await expect(loadSkill(tools, { name: "nonexistent" })).rejects.toThrow(/Unknown skill "nonexistent"/);
  });
});
