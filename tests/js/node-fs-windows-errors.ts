import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlink,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function capture(action: () => unknown) {
  try {
    action();
  } catch (error) {
    return error as NodeJS.ErrnoException & { dest?: string };
  }
  throw new Error("expected operation to fail");
}

function assertSystemError(
  error: NodeJS.ErrnoException & { dest?: string },
  expected: {
    code: string;
    errno: number;
    syscall: string;
    path: string;
    dest?: string;
    message: string;
  },
) {
  assert(error.code === expected.code, `code mismatch: ${error.code}`);
  assert(error.errno === expected.errno, `errno mismatch for ${expected.code}: ${error.errno}`);
  assert(error.syscall === expected.syscall, `syscall mismatch: ${error.syscall}`);
  assert(error.path === expected.path, `path mismatch: ${error.path}`);
  assert(error.dest === expected.dest, `dest mismatch: ${error.dest}`);
  assert(error.message === expected.message, `message mismatch:\n${error.message}\n${expected.message}`);
}

assert(process.platform === "win32", "Windows errno regression ran on a non-Windows host");

const uv = process.binding("uv") as {
  [name: string]: unknown;
  errname(errno: number): string;
  getErrorMap(): Map<number, [string, string]>;
  getErrorMessage(errno: number): string;
};

const expectedUvErrnos = {
  UV_EACCES: -4092,
  UV_EBUSY: -4082,
  UV_EEXIST: -4075,
  UV_EINVAL: -4071,
  UV_ENAMETOOLONG: -4064,
  UV_ENOENT: -4058,
  UV_ENOTEMPTY: -4051,
  UV_ENOTSUP: -4049,
  UV_EPERM: -4048,
};

for (const [name, errno] of Object.entries(expectedUvErrnos)) {
  assert(uv[name] === errno, `${name} mismatch: ${uv[name]}`);
  const [code, message] = uv.getErrorMap().get(errno) ?? [];
  assert(code === name.slice(3), `${name} map code mismatch: ${code}`);
  assert(uv.errname(errno) === code, `${name} errname mismatch`);
  assert(uv.getErrorMessage(errno) === message, `${name} error message mismatch`);
}
assert(osConstants.errno.ENOENT === 2, "os.constants.errno must retain the Windows CRT value");
assert(uv.UV_ENOENT !== -osConstants.errno.ENOENT, "libuv errno was incorrectly derived from the CRT errno");

const root = join(tmpdir(), `cottontail-windows-errors-${process.pid}`);
const target = join(root, "target.txt");
const destination = join(root, "destination.txt");
const missing = join(root, "missing.txt");
rmSync(root, { recursive: true, force: true });
mkdirSync(root);
writeFileSync(target, "target");
writeFileSync(destination, "destination");

try {
  assertSystemError(capture(() => lstatSync(missing)), {
    code: "ENOENT",
    errno: expectedUvErrnos.UV_ENOENT,
    syscall: "lstat",
    path: missing,
    message: `ENOENT: no such file or directory, lstat '${missing}'`,
  });

  assertSystemError(capture(() => readlinkSync(target)), {
    code: "EINVAL",
    errno: expectedUvErrnos.UV_EINVAL,
    syscall: "readlink",
    path: target,
    message: `EINVAL: invalid argument, readlink '${target}'`,
  });

  const expectedSymlinkError = {
    code: "EEXIST",
    errno: expectedUvErrnos.UV_EEXIST,
    syscall: "symlink",
    path: target,
    dest: destination,
    message: `EEXIST: file already exists, symlink '${target}' -> '${destination}'`,
  };
  assertSystemError(capture(() => symlinkSync(target, destination)), expectedSymlinkError);

  const callbackError = await new Promise<NodeJS.ErrnoException & { dest?: string }>((resolve, reject) => {
    symlink(target, destination, error => {
      if (error) resolve(error);
      else reject(new Error("expected callback symlink to fail"));
    });
  });
  assertSystemError(callbackError, expectedSymlinkError);

  assertSystemError(capture(() => unlinkSync(root)), {
    code: "EPERM",
    errno: expectedUvErrnos.UV_EPERM,
    syscall: "unlink",
    path: root,
    message: `EPERM: operation not permitted, unlink '${root}'`,
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("node fs windows error compatibility passed");
