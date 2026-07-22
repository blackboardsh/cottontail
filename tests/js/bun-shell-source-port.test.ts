import { afterAll, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { parseShell } from "../../src/runtime_modules/internal/bun-shell-parser.js";

const root = mkdtempSync(join(tmpdir(), "cottontail-shell-source-"));
const shell = (source: string) => $`${{ raw: source }}`.cwd(root).quiet().nothrow();
// COTTONTAIL-COMPAT: Vendored JSC startup can exceed Bun's 5s test default
// when one shell assertion launches multiple nested Cottontail processes.
const nestedRuntimeTimeout = 30_000;

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
    (VALUE=inner; echo "$VALUE"; exit 7; echo reached)
    echo "$VALUE"
    cat group.txt
  `);

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("inner\nreached\ngrouped\ngrouped\n");
  expect(readFileSync(join(root, "group.txt"), "utf8")).toBe("grouped\n");
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

test("exit is a regular builtin result in Bun 1.3.10 scripts", async () => {
  const topLevel = await shell("echo before; exit 37; echo unreachable");
  expect(topLevel.exitCode).toBe(0);
  expect(topLevel.stdout.toString()).toBe("before\nunreachable\n");

  const nested = await shell("(echo nested; exit 19; echo unreachable); echo parent");
  expect(nested.exitCode).toBe(0);
  expect(nested.stdout.toString()).toBe("nested\nunreachable\nparent\n");
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

test("background lists execute concurrently and wait joins their output", async () => {
  const delayed = "await Bun.sleep(30); console.log('background')";
  const output = await $`
    ${process.execPath} -e ${delayed} &
    echo foreground
    wait
    echo joined
  `.cwd(root).quiet().nothrow();

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("foreground\nbackground\njoined\n");
  expect(output.stderr.toString()).toBe("");
});

test("production parsing materializes async redirected subshell nodes", () => {
  const parseProduction = (source: string) => parseShell(source, {
    allowBackground: true,
    allowSubshellRedirects: true,
  });
  const parsed = parseProduction("(echo nested) > nested.txt & echo foreground");

  expect(parsed.items).toHaveLength(2);
  expect(parsed.items[0].type).toBe("async");
  expect(parsed.items[0].command.type).toBe("subshell");
  expect(parsed.items[0].command.redirects.map(redirect => redirect.operator)).toEqual([">"]);
  expect(parsed.items[1].type).toBe("command");
  expect(() => parseProduction("& echo unreachable")).toThrow('Unexpected "&"');
});

test("background pipelines preserve list ordering and final shell joins", async () => {
  const delayed = "await Bun.sleep(30); console.log('pipeline')";
  const output = await $`
    ${process.execPath} -e ${delayed} | cat &
    echo foreground
  `.cwd(root).quiet().nothrow();

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("foreground\npipeline\n");
  expect(output.stderr.toString()).toBe("");
});

test("background commands compose with boolean lists and command substitution", async () => {
  const delayed = "await Bun.sleep(30); console.log('background')";
  const booleanList = await $`
    echo prefix && ${process.execPath} -e ${delayed} &
    echo foreground
    wait
  `.cwd(root).quiet().nothrow();
  const substitution = await $`
    echo $(${process.execPath} -e ${delayed} & echo foreground)
  `.cwd(root).quiet().nothrow();

  expect(booleanList.exitCode).toBe(0);
  expect(booleanList.stdout.toString()).toBe("prefix\nforeground\nbackground\n");
  expect(substitution.exitCode).toBe(0);
  expect(substitution.stdout.toString()).toBe("foreground background\n");
}, nestedRuntimeTimeout);

test("background conditions and nested compounds share the shell job queue", async () => {
  const delayed = "await Bun.sleep(30); console.log('condition')";
  const condition = await $`
    if ${process.execPath} -e ${delayed} & then echo consequent; fi
    wait
  `.cwd(root).quiet().nothrow();
  const compounds = await shell(`
    VALUE=outer
    { echo grouped & wait; VALUE=grouped; }
    (echo nested & wait; VALUE=nested)
    echo "$VALUE"
  `);
  const compactCondition = await shell("if echo foo&then wait;fi; if echo foo;then echo bar&fi;wait");

  expect(condition.exitCode).toBe(0);
  expect(condition.stdout.toString()).toBe("consequent\ncondition\n");
  expect(compounds.exitCode).toBe(0);
  expect(compounds.stdout.toString()).toBe("grouped\nnested\ngrouped\n");
  expect(compactCondition.exitCode).toBe(0);
  expect(compactCondition.stdout.toString()).toBe("foo\nfoo\nbar\n");
});

test("background operators retain quoting and reject invalid binary placement", async () => {
  expect(await shell("echo '&' \\&").then(output => output.stdout.toString())).toBe("& &\n");
  expect(() => shell("echo background & && echo unreachable")).toThrow(
    '"&" is not allowed on the left-hand side of "&&"',
  );
});

test("wait reports the last background status", async () => {
  const output = await shell("true & false & wait");

  expect(output.exitCode).toBe(1);
  expect(output.stdout.toString()).toBe("");
  expect(output.stderr.toString()).toBe("");
});

test("background redirections complete before the shell promise resolves", async () => {
  const output = await shell("echo background > background.txt & echo foreground");

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("foreground\n");
  expect(readFileSync(join(root, "background.txt"), "utf8")).toBe("background\n");
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
}, nestedRuntimeTimeout);

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

test("repeated redirections release their descriptors deterministically", async () => {
  const probe = join(root, "descriptor-probe.txt");
  const before = openSync(probe, "a+");
  closeSync(before);

  for (let index = 0; index < 100; index += 1) {
    const output = await shell(`printf '%s' ${index} > repeated-output.txt`);
    expect(output.exitCode).toBe(0);
  }

  const after = openSync(probe, "a+");
  closeSync(after);
  expect(after).toBeLessThanOrEqual(before + 1);
});

test("subshell redirections preserve state isolation and descriptor flow", async () => {
  const output = await shell(`
    VALUE=outer
    (VALUE=inner; echo "$VALUE"; echo error >&2) > subshell.txt 2>&1
    (cat) < subshell.txt
    echo "$VALUE"
  `);

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("inner\nerror\nouter\n");
  expect(output.stderr.toString()).toBe("");
  expect(readFileSync(join(root, "subshell.txt"), "utf8")).toBe("inner\nerror\n");
});

test("nested redirected subshells isolate assignments at every level", async () => {
  const output = await shell(`
    VALUE=outer
    ((VALUE=inner; echo "$VALUE") > inner.txt; echo "$VALUE") > outer.txt
    echo "$VALUE"
    cat inner.txt outer.txt
  `);

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("outer\ninner\nouter\n");
  expect(output.stderr.toString()).toBe("");
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

test.skipIf(process.platform === "win32")("external producers tolerate an input-ignoring pipeline consumer", async () => {
  const yes = Bun.which("yes");
  expect(yes).not.toBeNull();

  const output = await $`${yes!} source | echo destination`.cwd(root).quiet().nothrow();

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("destination\n");
  expect(output.stderr.toString()).toBe("");
});

test.skipIf(process.platform === "win32")("large builtin output streams through external pipeline stages", async () => {
  const payload = "bun!".repeat(256 * 1024);
  const cat = Bun.which("cat");
  expect(cat).not.toBeNull();

  expect(await $`echo ${payload} | ${cat}`.text()).toBe(`${payload}\n`);
});

test("builtin edge cases match Bun 1.3.10", async () => {
  const output = await shell("basename /; seq -w");

  expect(output.exitCode).toBe(1);
  expect(output.stdout.toString()).toBe("/\n");
  expect(output.stderr.toString()).toBe(
    "usage: seq [-w] [-f format] [-s string] [-t string] [first [incr]] last\n",
  );
});

test("rm -d removes only empty directories", async () => {
  mkdirSync(join(root, "rm-empty"));
  mkdirSync(join(root, "rm-full"));
  writeFileSync(join(root, "rm-full", "file.txt"), "payload");

  const output = await shell("rm -d rm-empty rm-full");
  expect(output.exitCode).toBe(1);
  expect(output.stderr.toString()).toBe("rm: rm-full: Directory not empty\n");
  expect(existsSync(join(root, "rm-empty"))).toBe(false);
  expect(existsSync(join(root, "rm-full"))).toBe(true);
});

test("parser diagnostics preserve Bun's public syntax errors", () => {
  expect(() => parseShell("echo hi |")).toThrow("Unexpected EOF");
  expect(() => parseShell("echo )")).toThrow("Unexpected ')'");
  expect(() => parseShell("echo $(echo hi")).toThrow("Unclosed command substitution");
  expect(() => parseShell("(echo hi")).toThrow("Unclosed subshell");
  expect(() => parseShell("(echo hi) > output.txt")).toThrow(
    "Subshells with redirections are currently not supported. Please open a GitHub issue.",
  );
  expect(() => parseShell("echo hi &")).toThrow('Background commands "&" are not supported yet.');
});
