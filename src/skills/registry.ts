import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * A Skill's frontmatter metadata (design_doc §2.1): everything the LLM needs to decide whether a Skill is
 * relevant, without reading its full body. Presented to the LLM every turn (design_doc §2.2 step 1).
 */
export interface SkillMeta {
  /** Skill name; also the name of its subdirectory under skills/ (e.g. skills/task-creation/SKILL.md). */
  name: string;
  /** Trigger condition: when the LLM should load this Skill's body. */
  description: string;
}

/**
 * Default location of the Skill directory: the repository's own skills/, resolved relative to this file so
 * it works regardless of the process's current working directory (mirrors src/config/paths.ts's configDir,
 * which likewise avoids depending on cwd). Tests pass an explicit `dir` instead of relying on this.
 */
const DEFAULT_SKILLS_DIR = join(import.meta.dir, "..", "..", "skills");

/**
 * The line a SKILL.md's frontmatter block starts and ends with (design_doc §2.1).
 */
const FRONTMATTER_DELIMITER = "---";

/**
 * Splits a SKILL.md file's raw text into its frontmatter block and Markdown body.
 */
function splitFrontmatter(content: string, source: string): { frontmatter: string; body: string } {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new Error(`${source}: missing YAML frontmatter (file must start with "---")`);
  }
  const closingIndex = lines.findIndex((line, i) => i > 0 && line.trim() === FRONTMATTER_DELIMITER);
  if (closingIndex === -1) {
    throw new Error(`${source}: frontmatter block is not closed with a second "---"`);
  }
  const frontmatter = lines.slice(1, closingIndex).join("\n");
  // Strips the blank line(s) frontmatter Markdown conventionally leaves before the body, so loadSkillBody's
  // result starts directly at the body's own first heading rather than at empty lines.
  const body = lines
    .slice(closingIndex + 1)
    .join("\n")
    .replace(/^\n+/, "");
  return { frontmatter, body };
}

/**
 * Hand-written parser for SKILL.md's frontmatter (design_doc §2.1). Only the two fields Skills currently use
 * (`name`/`description`) are supported, one "key: value" pair per line; no YAML library is used (new
 * dependencies are out of scope for issue #9, see the implementation plan's risk notes).
 */
function parseFrontmatterFields(frontmatter: string, source: string): SkillMeta {
  const fields: Record<string, string> = {};
  for (const rawLine of frontmatter.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      throw new Error(`${source}: malformed frontmatter line "${rawLine}" (expected "key: value")`);
    }
    fields[line.slice(0, separatorIndex).trim()] = line.slice(separatorIndex + 1).trim();
  }
  if (!fields.name) {
    throw new Error(`${source}: frontmatter is missing "name"`);
  }
  if (!fields.description) {
    throw new Error(`${source}: frontmatter is missing "description"`);
  }
  return { name: fields.name, description: fields.description };
}

/**
 * Discovers every Skill under `dir` (default: the repository's skills/ directory), reading only its
 * frontmatter's name/description. This is the description list embedded in the system prompt every turn
 * (design_doc §2.2 step 1), so the LLM can decide whether to load a Skill's full body without it being
 * present in context by default.
 * A missing `dir` is not an error: satellite works with zero Skills configured.
 */
export async function discoverSkills(dir: string = DEFAULT_SKILLS_DIR): Promise<SkillMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // ENOENT (directory missing) is not an error: satellite works with zero Skills configured.
    // Anything else (EACCES, ENOTDIR, ...) is a real problem the caller must see, not silently 0 Skills.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const metas: SkillMeta[] = [];
  for (const entry of entries) {
    const path = join(dir, entry, "SKILL.md");
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    const { frontmatter } = splitFrontmatter(await file.text(), path);
    metas.push(parseFrontmatterFields(frontmatter, path));
  }
  return metas;
}

/**
 * Reads one Skill's body Markdown, with the frontmatter block stripped, for load_skill to hand back to the
 * LLM (design_doc §2.2 step 3).
 * @param name Skill name; also the name of its subdirectory under `dir`.
 * @throws When there is no `dir/name/SKILL.md`, so the tool layer can surface a clear error to the LLM
 * instead of a generic file-not-found.
 */
export async function loadSkillBody(name: string, dir: string = DEFAULT_SKILLS_DIR): Promise<string> {
  const path = join(dir, name, "SKILL.md");
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Unknown skill "${name}" (no ${path})`);
  }
  return splitFrontmatter(await file.text(), path).body;
}
