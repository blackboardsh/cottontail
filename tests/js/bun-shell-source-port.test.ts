import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const root = mkdtempSync(join(tmpdir(), "cottontail-shell-source-"));
const shell = (source: string) => $`${{ raw: source }}`.cwd(root).quiet().nothrow();

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("ports list comments, negation, and multiline operators", async () => {
  const output = await shell(`
    echo before # the rest of this line is ignored
    ! false &&
      ! true || echo inverted
  `);

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("before\ninverted\n");
  expect(output.stderr.toString()).toBe("");
});

test("groups share shell state while subshells isolate it", async () => {
  const output = await shell(`
    VALUE=outer
    { VALUE=grouped; echo "$VALUE"; } > group.txt
    (VALUE=inner; echo "$VALUE"; exit 7; echo unreachable) > sub.txt
    echo "$VALUE"
    cat group.txt sub.txt
  `);

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("grouped\ngrouped\ninner\n");
  expect(readFileSync(join(root, "group.txt"), "utf8")).toBe("grouped\n");
  expect(readFileSync(join(root, "sub.txt"), "utf8")).toBe("inner\n");
});

test("compound redirections are resolved before their bodies execute", async () => {
  mkdirSync(join(root, "child"), { recursive: true });
  const output = await shell(`
    { cd child; echo grouped; } > group-output.txt
    cd ..
    if true; then cd child; echo conditional; fi > if-output.txt
    cd ..
    cat group-output.txt if-output.txt
  `);

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("grouped\nconditional\n");
  expect(readFileSync(join(root, "group-output.txt"), "utf8")).toBe("grouped\n");
  expect(readFileSync(join(root, "if-output.txt"), "utf8")).toBe("conditional\n");
});

test("redirections preserve Bun descriptor merging and target order", async () => {
  const output = await shell(`
    { echo stdout-one; echo stderr-one >&2; } 2>&1 > stdout-only.txt
    { echo stdout-two; echo stderr-two >&2; } > combined.txt 2>&1
    echo payload > first.txt > second.txt
  `);

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("");
  expect(output.stderr.toString()).toBe("");
  expect(readFileSync(join(root, "stdout-only.txt"), "utf8")).toBe("stdout-one\nstderr-one\n");
  expect(readFileSync(join(root, "combined.txt"), "utf8")).toBe("stdout-two\nstderr-two\n");
  expect(readFileSync(join(root, "first.txt"), "utf8")).toBe("");
  expect(readFileSync(join(root, "second.txt"), "utf8")).toBe("payload\n");
});

test("exit terminates its shell scope and preserves its status", async () => {
  const topLevel = await shell("echo before; exit 37; echo unreachable");
  expect(topLevel.exitCode).toBe(37);
  expect(topLevel.stdout.toString()).toBe("before\n");

  const nested = await shell("(echo nested; exit 19; echo unreachable); echo parent");
  expect(nested.exitCode).toBe(0);
  expect(nested.stdout.toString()).toBe("nested\nparent\n");
});

test("parameter operators compose with quote-aware field splitting", async () => {
  const output = await shell(`
    EMPTY=
    WORDS="one two"
    echo "\${EMPTY:-fallback}:\${MISSING-default}"
    echo "\${ASSIGNED:=value}:$ASSIGNED:\${#ASSIGNED}"
    printf '<%s>\\n' prefix$WORDS" suffix"
  `);

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("fallback:default\nvalue:value:5\n<prefixone>\n<two suffix>\n");
});

test("recursive globs walk path components deterministically", async () => {
  mkdirSync(join(root, "nested", "deeper"), { recursive: true });
  writeFileSync(join(root, "nested", "a.txt"), "a");
  writeFileSync(join(root, "nested", "deeper", "b.txt"), "b");
  writeFileSync(join(root, "nested", "deeper", "skip.js"), "skip");

  const output = await shell("printf '%s\\n' nested/**/*.txt");
  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("nested/a.txt\nnested/deeper/b.txt\n");
});

test("conditional expressions support logical and file operators", async () => {
  writeFileSync(join(root, "condition-data"), "payload");
  const output = await shell(`
    MARK=set
    if [[ -s condition-data && ( condition-data -nt missing || -v MARK ) ]]; then
      echo accepted
    else
      echo rejected
    fi
  `);

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("accepted\n");
});

test("background lists are joined by wait without losing output", async () => {
  const output = await shell("echo background & echo foreground; wait");
  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("foreground\nbackground\n");
  expect(output.stderr.toString()).toBe("");
});
