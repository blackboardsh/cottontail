import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { windowsTarget } from './build-target.js';

if (process.platform !== 'win32') throw new Error('Run the ICU trampoline test on Windows');
const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'cottontail-icu-abi-'));
const source = join(temp, 'test.c');
const binary = join(temp, 'test.exe');
writeFileSync(source, `
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#define ICU_SYMBOL(name) void (*cottontail_icu_target_##name)(void) = 0;
#include "icu-symbols.inc"
#undef ICU_SYMBOL
typedef int64_t I;
static I integers(I a,I b,I c,I d,I e,I f,I g,I h,I i,I j) {
  return a+2*b+3*c+4*d+5*e+6*f+7*g+8*h+9*i+10*j;
}
static I replacement(I a,I b,I c,I d,I e,I f,I g,I h,I i,I j) {
  return -integers(a,b,c,d,e,f,g,h,i,j);
}
static double floats(double a,double b,double c,double d,double e,double f,double g,double h,double i,double j) {
  return a+2*b+3*c+4*d+5*e+6*f+7*g+8*h+9*i+10*j;
}
extern I u_getVersion(I,I,I,I,I,I,I,I,I,I);
extern double u_charType(double,double,double,double,double,double,double,double,double,double);
int main(void) {
  cottontail_icu_target_u_getVersion = (void (*)(void))integers;
  cottontail_icu_target_u_charType = (void (*)(void))floats;
  assert(u_getVersion(1,2,3,4,5,6,7,8,9,10) == 385);
  assert(u_charType(.5,1,1.5,2,2.5,3,3.5,4,4.5,5) == 192.5);
  cottontail_icu_target_u_getVersion = (void (*)(void))replacement;
  assert(u_getVersion(1,2,3,4,5,6,7,8,9,10) == -385);
  puts("ICU trampoline integer, floating-point, stack arguments and target replacement passed");
  return 0;
}
`);
try {
  execFileSync(join(root, 'vendors/zig/zig.exe'), ['cc', '-target', windowsTarget(process.arch).zig,
    '-O2', '-I', join(root, 'src/icu_bridge'), source, join(root, 'src/icu_bridge/windows-trampolines.S'), '-o', binary],
    { stdio: 'inherit', windowsHide: true, timeout: 300_000 });
  execFileSync(binary, [], { stdio: 'inherit', windowsHide: true, timeout: 30_000 });
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
