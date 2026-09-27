import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { SkillMeta } from "../skills/registry";

/**
 * Wraps the Skill layer's lazy-load step (design_doc §2.2 step 2-3) as an AI SDK tool. The description list
 * itself is presented separately, in the system prompt (system_prompt.ts), so this tool's own job is only to
 * hand back one Skill's full body once the LLM has decided, from that list, which Skill applies.
 * @param skills Every discovered Skill's metadata (from discoverSkills), used only to restrict `name` to a
 * known value; the description list itself lives in the system prompt, not here.
 * @param loadBody Reads a Skill's body by name (e.g. loadSkillBody bound to a directory); injectable so tests
 * never need real SKILL.md files on disk.
 */
export function createSkillTools(skills: SkillMeta[], loadBody: (name: string) => Promise<string>): ToolSet {
  const names = skills.map((s) => s.name);
  // z.enum requires at least one value at the type level; with no Skills discovered at all there is nothing
  // to restrict `name` to, so it falls back to a plain string (loadBody itself still rejects unknown names).
  const nameSchema = names.length > 0 ? z.enum(names as [string, ...string[]]) : z.string();

  return {
    load_skill: tool({
      description:
        "Load the full instructions of a Skill listed in the system prompt's Skill description list, before " +
        "following its steps. Call this once the request matches one of those descriptions.",
      inputSchema: z.object({
        name: nameSchema.describe("Skill name, exactly as listed in the system prompt's Skill description list"),
      }),
      execute: async ({ name }) => loadBody(name),
    }),
  };
}
