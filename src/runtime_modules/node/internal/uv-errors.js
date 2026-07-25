// libuv uses the host errno values on Unix, but assigns its own stable
// negative values on Windows. Keep this table separate from os.constants.errno:
// Node's SystemError.errno and process.binding("uv") expose the libuv values.
const baseUvEntries = [
  [-7, "E2BIG", "argument list too long"],
  [-13, "EACCES", "permission denied"],
  [-48, "EADDRINUSE", "address already in use"],
  [-49, "EADDRNOTAVAIL", "address not available"],
  [-47, "EAFNOSUPPORT", "address family not supported"],
  [-35, "EAGAIN", "resource temporarily unavailable"],
  [-3000, "EAI_ADDRFAMILY", "address family not supported"],
  [-3001, "EAI_AGAIN", "temporary failure"],
  [-3002, "EAI_BADFLAGS", "bad ai_flags value"],
  [-3013, "EAI_BADHINTS", "invalid value for hints"],
  [-3003, "EAI_CANCELED", "request canceled"],
  [-3004, "EAI_FAIL", "permanent failure"],
  [-3005, "EAI_FAMILY", "ai_family not supported"],
  [-3006, "EAI_MEMORY", "out of memory"],
  [-3007, "EAI_NODATA", "no address"],
  [-3008, "EAI_NONAME", "unknown node or service"],
  [-3009, "EAI_OVERFLOW", "argument buffer overflow"],
  [-3014, "EAI_PROTOCOL", "resolved protocol is unknown"],
  [-3010, "EAI_SERVICE", "service not available for socket type"],
  [-3011, "EAI_SOCKTYPE", "socket type not supported"],
  [-37, "EALREADY", "connection already in progress"],
  [-9, "EBADF", "bad file descriptor"],
  [-16, "EBUSY", "resource busy or locked"],
  [-89, "ECANCELED", "operation canceled"],
  [-4080, "ECHARSET", "invalid Unicode character"],
  [-53, "ECONNABORTED", "software caused connection abort"],
  [-61, "ECONNREFUSED", "connection refused"],
  [-54, "ECONNRESET", "connection reset by peer"],
  [-39, "EDESTADDRREQ", "destination address required"],
  [-17, "EEXIST", "file already exists"],
  [-14, "EFAULT", "bad address in system call argument"],
  [-27, "EFBIG", "file too large"],
  [-65, "EHOSTUNREACH", "host is unreachable"],
  [-4, "EINTR", "interrupted system call"],
  [-22, "EINVAL", "invalid argument"],
  [-5, "EIO", "i/o error"],
  [-56, "EISCONN", "socket is already connected"],
  [-21, "EISDIR", "illegal operation on a directory"],
  [-62, "ELOOP", "too many symbolic links encountered"],
  [-24, "EMFILE", "too many open files"],
  [-40, "EMSGSIZE", "message too long"],
  [-63, "ENAMETOOLONG", "name too long"],
  [-50, "ENETDOWN", "network is down"],
  [-51, "ENETUNREACH", "network is unreachable"],
  [-23, "ENFILE", "file table overflow"],
  [-55, "ENOBUFS", "no buffer space available"],
  [-19, "ENODEV", "no such device"],
  [-2, "ENOENT", "no such file or directory"],
  [-12, "ENOMEM", "not enough memory"],
  [-4056, "ENONET", "machine is not on the network"],
  [-42, "ENOPROTOOPT", "protocol not available"],
  [-28, "ENOSPC", "no space left on device"],
  [-78, "ENOSYS", "function not implemented"],
  [-57, "ENOTCONN", "socket is not connected"],
  [-20, "ENOTDIR", "not a directory"],
  [-66, "ENOTEMPTY", "directory not empty"],
  [-38, "ENOTSOCK", "socket operation on non-socket"],
  [-45, "ENOTSUP", "operation not supported on socket"],
  [-84, "EOVERFLOW", "value too large for defined data type"],
  [-1, "EPERM", "operation not permitted"],
  [-32, "EPIPE", "broken pipe"],
  [-100, "EPROTO", "protocol error"],
  [-43, "EPROTONOSUPPORT", "protocol not supported"],
  [-41, "EPROTOTYPE", "protocol wrong type for socket"],
  [-34, "ERANGE", "result too large"],
  [-30, "EROFS", "read-only file system"],
  [-58, "ESHUTDOWN", "cannot send after transport endpoint shutdown"],
  [-29, "ESPIPE", "invalid seek"],
  [-3, "ESRCH", "no such process"],
  [-60, "ETIMEDOUT", "connection timed out"],
  [-26, "ETXTBSY", "text file is busy"],
  [-18, "EXDEV", "cross-device link not permitted"],
  [-4094, "UNKNOWN", "unknown error"],
  [-4095, "EOF", "end of file"],
  [-6, "ENXIO", "no such device or address"],
  [-31, "EMLINK", "too many links"],
  [-64, "EHOSTDOWN", "host is down"],
  [-4030, "EREMOTEIO", "remote I/O error"],
  [-25, "ENOTTY", "inappropriate ioctl for device"],
  [-79, "EFTYPE", "inappropriate file type or format"],
  [-92, "EILSEQ", "illegal byte sequence"],
  [-44, "ESOCKTNOSUPPORT", "socket type not supported"],
  [-96, "ENODATA", "no data available"],
  [-4023, "EUNATCH", "protocol driver not attached"],
  [-8, "ENOEXEC", "exec format error"],
];

// Extracted from Node v24 on Windows. EAI errors and libuv's sentinel values
// already use their platform-independent numbers, so only the system errors
// that differ from the Unix table need overrides.
const windowsErrnoByCode = {
  E2BIG: -4093,
  EACCES: -4092,
  EADDRINUSE: -4091,
  EADDRNOTAVAIL: -4090,
  EAFNOSUPPORT: -4089,
  EAGAIN: -4088,
  EALREADY: -4084,
  EBADF: -4083,
  EBUSY: -4082,
  ECANCELED: -4081,
  ECHARSET: -4080,
  ECONNABORTED: -4079,
  ECONNREFUSED: -4078,
  ECONNRESET: -4077,
  EDESTADDRREQ: -4076,
  EEXIST: -4075,
  EFAULT: -4074,
  EFBIG: -4036,
  EHOSTUNREACH: -4073,
  EINTR: -4072,
  EINVAL: -4071,
  EIO: -4070,
  EISCONN: -4069,
  EISDIR: -4068,
  ELOOP: -4067,
  EMFILE: -4066,
  EMSGSIZE: -4065,
  ENAMETOOLONG: -4064,
  ENETDOWN: -4063,
  ENETUNREACH: -4062,
  ENFILE: -4061,
  ENOBUFS: -4060,
  ENODEV: -4059,
  ENOENT: -4058,
  ENOMEM: -4057,
  ENONET: -4056,
  ENOPROTOOPT: -4035,
  ENOSPC: -4055,
  ENOSYS: -4054,
  ENOTCONN: -4053,
  ENOTDIR: -4052,
  ENOTEMPTY: -4051,
  ENOTSOCK: -4050,
  ENOTSUP: -4049,
  EOVERFLOW: -4026,
  EPERM: -4048,
  EPIPE: -4047,
  EPROTO: -4046,
  EPROTONOSUPPORT: -4045,
  EPROTOTYPE: -4044,
  ERANGE: -4034,
  EROFS: -4043,
  ESHUTDOWN: -4042,
  ESPIPE: -4041,
  ESRCH: -4040,
  ETIMEDOUT: -4039,
  ETXTBSY: -4038,
  EXDEV: -4037,
  ENXIO: -4033,
  EMLINK: -4032,
  EHOSTDOWN: -4031,
  EREMOTEIO: -4030,
  ENOTTY: -4029,
  EFTYPE: -4028,
  EILSEQ: -4027,
  ESOCKTNOSUPPORT: -4025,
  ENODATA: -4024,
  EUNATCH: -4023,
  ENOEXEC: -4022,
};

const platform = globalThis.cottontail?.platform?.() ?? globalThis.process?.platform;
const entries = platform === "win32"
  ? baseUvEntries.map(([errno, code, message]) => [windowsErrnoByCode[code] ?? errno, code, message])
  : baseUvEntries;

export const uvErrorMap = new Map(
  entries.map(([errno, code, message]) => [errno, [code, message]]),
);

export const uvErrorByCode = new Map(
  entries.map(([errno, code, message]) => [code, [errno, message]]),
);

export function uvErrnoFromCode(code, fallback = -5) {
  return uvErrorByCode.get(String(code))?.[0] ?? fallback;
}

export function uvMessageFromCode(code) {
  return uvErrorByCode.get(String(code))?.[1];
}

export function uvCodeFromMessage(message) {
  const normalized = String(message).toLowerCase();
  let best;
  for (const [code, [, description]] of uvErrorByCode) {
    if (!normalized.includes(description.toLowerCase())) continue;
    if (!best || description.length > best[1].length) best = [code, description];
  }
  return best?.[0];
}
