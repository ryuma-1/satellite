import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, loadSkillBody } from "./registry";

describe("discoverSkills / loadSkillBody", () => {
  /** Temporary skills/ directory populated by each test. */
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "satellite-skills-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes `dir/name/SKILL.md` with the given raw content. */
  async function writeSkill(name: string, content: string): Promise<void> {
    await Bun.write(join(dir, name, "SKILL.md"), content);
  }

  test("discovers a Skill's name/description from its frontmatter", async () => {
    await writeSkill(
      "task-creation",
      ["---", "name: task-creation", "description: タスク作成を依頼されたときに使用する", "---", "", "# 手順", "1. ..."].join("\n"),
    );

    const skills = await discoverSkills(dir);

    expect(skills).toEqual([{ name: "task-creation", description: "タスク作成を依頼されたときに使用する" }]);
  });

  test("discovers every Skill under the directory", async () => {
    await writeSkill("a", ["---", "name: a", "description: skill a", "---", "body"].join("\n"));
    await writeSkill("b", ["---", "name: b", "description: skill b", "---", "body"].join("\n"));

    const skills = await discoverSkills(dir);

    expect(skills.map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  test("returns an empty list for a directory with no skills", async () => {
    expect(await discoverSkills(dir)).toEqual([]);
  });

  test("returns an empty list when the directory itself does not exist", async () => {
    expect(await discoverSkills(join(dir, "missing"))).toEqual([]);
  });

  test("rethrows readdir errors other than ENOENT (e.g. ENOTDIR)", async () => {
    // A plain file used as `dir` makes readdir() fail with ENOTDIR, not ENOENT,
    // so this must surface rather than being treated as "0 skills".
    const filePath = join(dir, "not-a-directory");
    await Bun.write(filePath, "not a directory");

    await expect(discoverSkills(filePath)).rejects.toThrow(/ENOTDIR/);
  });

  test("ignores entries with no SKILL.md", async () => {
    await Bun.write(join(dir, "not-a-skill", "README.md"), "not a skill");

    expect(await discoverSkills(dir)).toEqual([]);
  });

  test("throws when the frontmatter is missing name", async () => {
    await writeSkill("broken", ["---", "description: only a description", "---", "body"].join("\n"));
    await expect(discoverSkills(dir)).rejects.toThrow(/missing "name"/);
  });

  test("throws when the frontmatter is missing description", async () => {
    await writeSkill("broken", ["---", "name: broken", "---", "body"].join("\n"));
    await expect(discoverSkills(dir)).rejects.toThrow(/missing "description"/);
  });

  test("throws when the file has no frontmatter block at all", async () => {
    await writeSkill("broken", "# just a heading, no frontmatter\n");
    await expect(discoverSkills(dir)).rejects.toThrow(/missing YAML frontmatter/);
  });

  test("throws when the frontmatter block is never closed", async () => {
    await writeSkill("broken", ["---", "name: broken", "description: unterminated"].join("\n"));
    await expect(discoverSkills(dir)).rejects.toThrow(/not closed/);
  });

  test("loadSkillBody returns the body with the frontmatter stripped", async () => {
    await writeSkill(
      "task-creation",
      ["---", "name: task-creation", "description: desc", "---", "", "# 手順", "", "1. 最初のステップ"].join("\n"),
    );

    const body = await loadSkillBody("task-creation", dir);

    expect(body).toBe("# 手順\n\n1. 最初のステップ");
  });

  test("loadSkillBody rejects an unknown skill name", async () => {
    await expect(loadSkillBody("nonexistent", dir)).rejects.toThrow(/Unknown skill "nonexistent"/);
  });
});
