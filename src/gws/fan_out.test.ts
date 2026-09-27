import { describe, expect, test } from "bun:test";
import { fanOut } from "./fan_out";

describe("fanOut", () => {
  test("merges results from every target", async () => {
    const targets = ["a", "b", "c"];
    const items = await fanOut(
      targets,
      (t) => t,
      async (t) => [t.toUpperCase()],
    );
    expect(items).toEqual(["A", "B", "C"]);
  });

  test("returns an empty array for no targets, without calling fn", async () => {
    let calls = 0;
    const items = await fanOut(
      [] as string[],
      (t) => t,
      async (t) => {
        calls++;
        return [t];
      },
    );
    expect(items).toEqual([]);
    expect(calls).toBe(0);
  });

  test("fails the whole call and names every failing target, instead of returning partial results", async () => {
    const targets = ["ok1", "fail1", "ok2", "fail2"];
    await expect(
      fanOut(
        targets,
        (t) => t,
        async (t) => {
          if (t.startsWith("fail")) throw new Error(`boom: ${t}`);
          return [t];
        },
      ),
    ).rejects.toThrow("gws request failed for 2 target(s):\nfail1: boom: fail1\nfail2: boom: fail2");
  });

  test("runs every target in parallel rather than sequentially", async () => {
    const start = Date.now();
    await fanOut(
      [1, 2, 3],
      (t) => String(t),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [1];
      },
    );
    // Sequential execution would take ~150ms; parallel execution should stay well under that.
    expect(Date.now() - start).toBeLessThan(120);
  });
});
