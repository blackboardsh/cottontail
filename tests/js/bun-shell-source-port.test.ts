import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { parseShell } from "../../src/runtime_modules/internal/bun-shell-parser.js";

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

test("deep brace groups flatten while independently escaped braces stay literal", async () => {
  const output = await shell("printf '<%s>\\n' {1,{2,{3,{4}}}} pre\\{x,y\\}{a,b} \\*.txt");

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("<1>\n<2>\n<3>\n<4>\n<pre{x,y}a>\n<pre{x,y}b>\n<*.txt>\n");
});

test("command substitutions use Bun's quoted and unquoted whitespace rules", async () => {
  const output = await shell(`
    printf '<%s>\\n' "$(printf 'value   \\n\\t')"
    printf '<%s>\\n' $(printf 'one  \\n  two\\n')
  `);

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("<value>\n<one>\n<two>\n");
  expect(output.stderr.toString()).toBe("");
});

test("command-local assignments remain separate from shell expansion state", async () => {
  const printValue = "console.log(process.env.VALUE)";
  const output = await $`
    VALUE=outer
    VALUE=inner ${process.execPath} -e ${printValue}
    ${process.execPath} -e ${printValue}
    echo $VALUE
  `.cwd(root).quiet().nothrow();

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("inner\ninner\nouter\n");
});

test("redirections open in source order before a compound body runs", async () => {
  const output = await shell(`
    { echo should-not-run > body-ran.txt; } > missing/compound.txt
    echo ignored > opened-first.txt < missing-input.txt
    echo ignored < another-missing.txt > must-not-exist.txt
  `);

  expect(output.exitCode).toBe(1);
  expect(existsSync(join(root, "body-ran.txt"))).toBe(false);
  expect(readFileSync(join(root, "opened-first.txt"), "utf8")).toBe("");
  expect(existsSync(join(root, "must-not-exist.txt"))).toBe(false);
  expect(output.stderr.toString()).toContain("No such file or directory");
});

test("ANSI-C quotes decode complete escape sequences exactly once", async () => {
  const output = await shell("printf '%s' $'A\\n\\x42\\103'");

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("A\nBC");
});

test("echo escape sequences preserve Bun's byte output", async () => {
  const output = await shell("echo -ne '\\0377\\x80'");

  expect(output.exitCode).toBe(0);
  expect(Array.from(output.stdout)).toEqual([0xff, 0x80]);
});

test("assignment-only pipeline entries are transparent", async () => {
  const output = await shell("printf payload | VALUE=ignored | cat");

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("payload");
});

test("pipeline consumers cancel input-ignoring producers", async () => {
  const output = await shell("yes source | cat | echo destination");

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("destination\n");
  expect(output.stderr.toString()).toBe("");
});

test("parser diagnostics preserve Bun's public syntax errors", () => {
  expect(() => parseShell("echo hi |")).toThrow("Unexpected EOF");
  expect(() => parseShell("echo )")).toThrow("Unexpected ')'");
  expect(() => parseShell("echo $(echo hi")).toThrow("Unclosed command substitution");
  expect(() => parseShell("(echo hi")).toThrow("Unclosed subshell");
});
