// Cross-platform-independent values were generated from Node v24.11.1.
// Errno, filesystem, signal, and dlopen values come from the target host.

const hostConstants = globalThis.cottontail?.platformConstants?.() ?? {};
const hostConstant = (name, fallback = undefined) => {
  const value = hostConstants[name];
  return Number.isInteger(value) ? value : fallback;
};

export const COPYFILE_EXCL = 1;
export const COPYFILE_FICLONE = 2;
export const COPYFILE_FICLONE_FORCE = 4;
export const DH_CHECK_P_NOT_PRIME = 1;
export const DH_CHECK_P_NOT_SAFE_PRIME = 2;
export const DH_NOT_SUITABLE_GENERATOR = 8;
export const DH_UNABLE_TO_CHECK_GENERATOR = 4;
export const E2BIG = hostConstant("E2BIG", 7);
export const EACCES = hostConstant("EACCES", 13);
export const EADDRINUSE = hostConstant("EADDRINUSE", 48);
export const EADDRNOTAVAIL = hostConstant("EADDRNOTAVAIL", 49);
export const EAFNOSUPPORT = hostConstant("EAFNOSUPPORT", 47);
export const EAGAIN = hostConstant("EAGAIN", 35);
export const EALREADY = hostConstant("EALREADY", 37);
export const EBADF = hostConstant("EBADF", 9);
export const EBADMSG = hostConstant("EBADMSG", 94);
export const EBUSY = hostConstant("EBUSY", 16);
export const ECANCELED = hostConstant("ECANCELED", 89);
export const ECHILD = hostConstant("ECHILD", 10);
export const ECONNABORTED = hostConstant("ECONNABORTED", 53);
export const ECONNREFUSED = hostConstant("ECONNREFUSED", 61);
export const ECONNRESET = hostConstant("ECONNRESET", 54);
export const EDEADLK = hostConstant("EDEADLK", 11);
export const EDESTADDRREQ = hostConstant("EDESTADDRREQ", 39);
export const EDOM = hostConstant("EDOM", 33);
export const EDQUOT = hostConstant("EDQUOT", 69);
export const EEXIST = hostConstant("EEXIST", 17);
export const EFAULT = hostConstant("EFAULT", 14);
export const EFBIG = hostConstant("EFBIG", 27);
export const EHOSTUNREACH = hostConstant("EHOSTUNREACH", 65);
export const EIDRM = hostConstant("EIDRM", 90);
export const EILSEQ = hostConstant("EILSEQ", 92);
export const EINPROGRESS = hostConstant("EINPROGRESS", 36);
export const EINTR = hostConstant("EINTR", 4);
export const EINVAL = hostConstant("EINVAL", 22);
export const EIO = hostConstant("EIO", 5);
export const EISCONN = hostConstant("EISCONN", 56);
export const EISDIR = hostConstant("EISDIR", 21);
export const ELOOP = hostConstant("ELOOP", 62);
export const EMFILE = hostConstant("EMFILE", 24);
export const EMLINK = hostConstant("EMLINK", 31);
export const EMSGSIZE = hostConstant("EMSGSIZE", 40);
export const EMULTIHOP = hostConstant("EMULTIHOP", 95);
export const ENAMETOOLONG = hostConstant("ENAMETOOLONG", 63);
export const ENETDOWN = hostConstant("ENETDOWN", 50);
export const ENETRESET = hostConstant("ENETRESET", 52);
export const ENETUNREACH = hostConstant("ENETUNREACH", 51);
export const ENFILE = hostConstant("ENFILE", 23);
export const ENGINE_METHOD_ALL = 65535;
export const ENGINE_METHOD_CIPHERS = 64;
export const ENGINE_METHOD_DH = 4;
export const ENGINE_METHOD_DIGESTS = 128;
export const ENGINE_METHOD_DSA = 2;
export const ENGINE_METHOD_EC = 2048;
export const ENGINE_METHOD_NONE = 0;
export const ENGINE_METHOD_PKEY_ASN1_METHS = 1024;
export const ENGINE_METHOD_PKEY_METHS = 512;
export const ENGINE_METHOD_RAND = 8;
export const ENGINE_METHOD_RSA = 1;
export const ENOBUFS = hostConstant("ENOBUFS", 55);
export const ENODATA = hostConstant("ENODATA", 96);
export const ENODEV = hostConstant("ENODEV", 19);
export const ENOENT = hostConstant("ENOENT", 2);
export const ENOEXEC = hostConstant("ENOEXEC", 8);
export const ENOLCK = hostConstant("ENOLCK", 77);
export const ENOLINK = hostConstant("ENOLINK", 97);
export const ENOMEM = hostConstant("ENOMEM", 12);
export const ENOMSG = hostConstant("ENOMSG", 91);
export const ENOPROTOOPT = hostConstant("ENOPROTOOPT", 42);
export const ENOSPC = hostConstant("ENOSPC", 28);
export const ENOSR = hostConstant("ENOSR", 98);
export const ENOSTR = hostConstant("ENOSTR", 99);
export const ENOSYS = hostConstant("ENOSYS", 78);
export const ENOTCONN = hostConstant("ENOTCONN", 57);
export const ENOTDIR = hostConstant("ENOTDIR", 20);
export const ENOTEMPTY = hostConstant("ENOTEMPTY", 66);
export const ENOTSOCK = hostConstant("ENOTSOCK", 38);
export const ENOTSUP = hostConstant("ENOTSUP", 45);
export const ENOTTY = hostConstant("ENOTTY", 25);
export const ENXIO = hostConstant("ENXIO", 6);
export const EOPNOTSUPP = hostConstant("EOPNOTSUPP", 102);
export const EOVERFLOW = hostConstant("EOVERFLOW", 84);
export const EPERM = hostConstant("EPERM", 1);
export const EPIPE = hostConstant("EPIPE", 32);
export const EPROTO = hostConstant("EPROTO", 100);
export const EPROTONOSUPPORT = hostConstant("EPROTONOSUPPORT", 43);
export const EPROTOTYPE = hostConstant("EPROTOTYPE", 41);
export const ERANGE = hostConstant("ERANGE", 34);
export const EROFS = hostConstant("EROFS", 30);
export const ESPIPE = hostConstant("ESPIPE", 29);
export const ESRCH = hostConstant("ESRCH", 3);
export const ESTALE = hostConstant("ESTALE", 70);
export const ETIME = hostConstant("ETIME", 101);
export const ETIMEDOUT = hostConstant("ETIMEDOUT", 60);
export const ETXTBSY = hostConstant("ETXTBSY", 26);
export const EWOULDBLOCK = hostConstant("EWOULDBLOCK", 35);
export const EXDEV = hostConstant("EXDEV", 18);
export const F_OK = hostConstant("F_OK", 0);
export const OPENSSL_VERSION_NUMBER = 810549312;
export const O_APPEND = hostConstant("O_APPEND", 8);
export const O_CREAT = hostConstant("O_CREAT", 512);
export const O_DIRECTORY = hostConstant("O_DIRECTORY", 1048576);
export const O_DIRECT = hostConstant("O_DIRECT");
export const O_DSYNC = hostConstant("O_DSYNC", 4194304);
export const O_EXCL = hostConstant("O_EXCL", 2048);
export const O_NOATIME = hostConstant("O_NOATIME");
export const O_NOCTTY = hostConstant("O_NOCTTY", 131072);
export const O_NOFOLLOW = hostConstant("O_NOFOLLOW", 256);
export const O_NONBLOCK = hostConstant("O_NONBLOCK", 4);
export const O_RDONLY = hostConstant("O_RDONLY", 0);
export const O_RDWR = hostConstant("O_RDWR", 2);
export const O_SYMLINK = hostConstant("O_SYMLINK");
export const O_SYNC = hostConstant("O_SYNC", 128);
export const O_TRUNC = hostConstant("O_TRUNC", 1024);
export const O_WRONLY = hostConstant("O_WRONLY", 1);
export const POINT_CONVERSION_COMPRESSED = 2;
export const POINT_CONVERSION_HYBRID = 6;
export const POINT_CONVERSION_UNCOMPRESSED = 4;
export const PRIORITY_ABOVE_NORMAL = -7;
export const PRIORITY_BELOW_NORMAL = 10;
export const PRIORITY_HIGH = -14;
export const PRIORITY_HIGHEST = -20;
export const PRIORITY_LOW = 19;
export const PRIORITY_NORMAL = 0;
export const RSA_NO_PADDING = 3;
export const RSA_PKCS1_OAEP_PADDING = 4;
export const RSA_PKCS1_PADDING = 1;
export const RSA_PKCS1_PSS_PADDING = 6;
export const RSA_PSS_SALTLEN_AUTO = -2;
export const RSA_PSS_SALTLEN_DIGEST = -1;
export const RSA_PSS_SALTLEN_MAX_SIGN = -2;
export const RSA_X931_PADDING = 5;
export const RTLD_DEEPBIND = hostConstant("RTLD_DEEPBIND");
export const RTLD_GLOBAL = hostConstant("RTLD_GLOBAL", 8);
export const RTLD_LAZY = hostConstant("RTLD_LAZY", 1);
export const RTLD_LOCAL = hostConstant("RTLD_LOCAL", 4);
export const RTLD_NOW = hostConstant("RTLD_NOW", 2);
export const R_OK = hostConstant("R_OK", 4);
export const SIGABRT = hostConstant("SIGABRT", 6);
export const SIGALRM = hostConstant("SIGALRM", 14);
export const SIGBUS = hostConstant("SIGBUS", 10);
export const SIGCHLD = hostConstant("SIGCHLD", 20);
export const SIGCONT = hostConstant("SIGCONT", 19);
export const SIGFPE = hostConstant("SIGFPE", 8);
export const SIGHUP = hostConstant("SIGHUP", 1);
export const SIGILL = hostConstant("SIGILL", 4);
export const SIGINFO = hostConstant("SIGINFO");
export const SIGINT = hostConstant("SIGINT", 2);
export const SIGIO = hostConstant("SIGIO", 23);
export const SIGIOT = hostConstant("SIGIOT", 6);
export const SIGKILL = hostConstant("SIGKILL", 9);
export const SIGPIPE = hostConstant("SIGPIPE", 13);
export const SIGPOLL = hostConstant("SIGPOLL");
export const SIGPROF = hostConstant("SIGPROF", 27);
export const SIGPWR = hostConstant("SIGPWR");
export const SIGQUIT = hostConstant("SIGQUIT", 3);
export const SIGSEGV = hostConstant("SIGSEGV", 11);
export const SIGSTKFLT = hostConstant("SIGSTKFLT");
export const SIGSTOP = hostConstant("SIGSTOP", 17);
export const SIGSYS = hostConstant("SIGSYS", 12);
export const SIGTERM = hostConstant("SIGTERM", 15);
export const SIGTRAP = hostConstant("SIGTRAP", 5);
export const SIGTSTP = hostConstant("SIGTSTP", 18);
export const SIGTTIN = hostConstant("SIGTTIN", 21);
export const SIGTTOU = hostConstant("SIGTTOU", 22);
export const SIGURG = hostConstant("SIGURG", 16);
export const SIGUSR1 = hostConstant("SIGUSR1", 30);
export const SIGUSR2 = hostConstant("SIGUSR2", 31);
export const SIGVTALRM = hostConstant("SIGVTALRM", 26);
export const SIGWINCH = hostConstant("SIGWINCH", 28);
export const SIGXCPU = hostConstant("SIGXCPU", 24);
export const SIGXFSZ = hostConstant("SIGXFSZ", 25);
export const SSL_OP_ALL = 2147485776;
export const SSL_OP_ALLOW_NO_DHE_KEX = 1024;
export const SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION = 262144;
export const SSL_OP_CIPHER_SERVER_PREFERENCE = 4194304;
export const SSL_OP_CISCO_ANYCONNECT = 32768;
export const SSL_OP_COOKIE_EXCHANGE = 8192;
export const SSL_OP_CRYPTOPRO_TLSEXT_BUG = 2147483648;
export const SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS = 2048;
export const SSL_OP_LEGACY_SERVER_CONNECT = 4;
export const SSL_OP_NO_COMPRESSION = 131072;
export const SSL_OP_NO_ENCRYPT_THEN_MAC = 524288;
export const SSL_OP_NO_QUERY_MTU = 4096;
export const SSL_OP_NO_RENEGOTIATION = 1073741824;
export const SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION = 65536;
export const SSL_OP_NO_SSLv2 = 0;
export const SSL_OP_NO_SSLv3 = 33554432;
export const SSL_OP_NO_TICKET = 16384;
export const SSL_OP_NO_TLSv1 = 67108864;
export const SSL_OP_NO_TLSv1_1 = 268435456;
export const SSL_OP_NO_TLSv1_2 = 134217728;
export const SSL_OP_NO_TLSv1_3 = 536870912;
export const SSL_OP_PRIORITIZE_CHACHA = 2097152;
export const SSL_OP_TLS_ROLLBACK_BUG = 8388608;
export const S_IFBLK = hostConstant("S_IFBLK", 24576);
export const S_IFCHR = hostConstant("S_IFCHR", 8192);
export const S_IFDIR = hostConstant("S_IFDIR", 16384);
export const S_IFIFO = hostConstant("S_IFIFO", 4096);
export const S_IFLNK = hostConstant("S_IFLNK", 40960);
export const S_IFMT = hostConstant("S_IFMT", 61440);
export const S_IFREG = hostConstant("S_IFREG", 32768);
export const S_IFSOCK = hostConstant("S_IFSOCK", 49152);
export const S_IRGRP = hostConstant("S_IRGRP", 32);
export const S_IROTH = hostConstant("S_IROTH", 4);
export const S_IRUSR = hostConstant("S_IRUSR", 256);
export const S_IRWXG = hostConstant("S_IRWXG", 56);
export const S_IRWXO = hostConstant("S_IRWXO", 7);
export const S_IRWXU = hostConstant("S_IRWXU", 448);
export const S_IWGRP = hostConstant("S_IWGRP", 16);
export const S_IWOTH = hostConstant("S_IWOTH", 2);
export const S_IWUSR = hostConstant("S_IWUSR", 128);
export const S_IXGRP = hostConstant("S_IXGRP", 8);
export const S_IXOTH = hostConstant("S_IXOTH", 1);
export const S_IXUSR = hostConstant("S_IXUSR", 64);
export const TLS1_1_VERSION = 770;
export const TLS1_2_VERSION = 771;
export const TLS1_3_VERSION = 772;
export const TLS1_VERSION = 769;
export const UV_DIRENT_BLOCK = 7;
export const UV_DIRENT_CHAR = 6;
export const UV_DIRENT_DIR = 2;
export const UV_DIRENT_FIFO = 4;
export const UV_DIRENT_FILE = 1;
export const UV_DIRENT_LINK = 3;
export const UV_DIRENT_SOCKET = 5;
export const UV_DIRENT_UNKNOWN = 0;
export const UV_FS_COPYFILE_EXCL = 1;
export const UV_FS_COPYFILE_FICLONE = 2;
export const UV_FS_COPYFILE_FICLONE_FORCE = 4;
export const UV_FS_O_FILEMAP = 0;
export const UV_FS_SYMLINK_DIR = 1;
export const UV_FS_SYMLINK_JUNCTION = 2;
export const W_OK = hostConstant("W_OK", 2);
export const X_OK = hostConstant("X_OK", 1);
export const defaultCoreCipherList = "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";

export default Object.freeze({
  COPYFILE_EXCL,
  COPYFILE_FICLONE,
  COPYFILE_FICLONE_FORCE,
  DH_CHECK_P_NOT_PRIME,
  DH_CHECK_P_NOT_SAFE_PRIME,
  DH_NOT_SUITABLE_GENERATOR,
  DH_UNABLE_TO_CHECK_GENERATOR,
  E2BIG,
  EACCES,
  EADDRINUSE,
  EADDRNOTAVAIL,
  EAFNOSUPPORT,
  EAGAIN,
  EALREADY,
  EBADF,
  EBADMSG,
  EBUSY,
  ECANCELED,
  ECHILD,
  ECONNABORTED,
  ECONNREFUSED,
  ECONNRESET,
  EDEADLK,
  EDESTADDRREQ,
  EDOM,
  EDQUOT,
  EEXIST,
  EFAULT,
  EFBIG,
  EHOSTUNREACH,
  EIDRM,
  EILSEQ,
  EINPROGRESS,
  EINTR,
  EINVAL,
  EIO,
  EISCONN,
  EISDIR,
  ELOOP,
  EMFILE,
  EMLINK,
  EMSGSIZE,
  EMULTIHOP,
  ENAMETOOLONG,
  ENETDOWN,
  ENETRESET,
  ENETUNREACH,
  ENFILE,
  ENGINE_METHOD_ALL,
  ENGINE_METHOD_CIPHERS,
  ENGINE_METHOD_DH,
  ENGINE_METHOD_DIGESTS,
  ENGINE_METHOD_DSA,
  ENGINE_METHOD_EC,
  ENGINE_METHOD_NONE,
  ENGINE_METHOD_PKEY_ASN1_METHS,
  ENGINE_METHOD_PKEY_METHS,
  ENGINE_METHOD_RAND,
  ENGINE_METHOD_RSA,
  ENOBUFS,
  ENODATA,
  ENODEV,
  ENOENT,
  ENOEXEC,
  ENOLCK,
  ENOLINK,
  ENOMEM,
  ENOMSG,
  ENOPROTOOPT,
  ENOSPC,
  ENOSR,
  ENOSTR,
  ENOSYS,
  ENOTCONN,
  ENOTDIR,
  ENOTEMPTY,
  ENOTSOCK,
  ENOTSUP,
  ENOTTY,
  ENXIO,
  EOPNOTSUPP,
  EOVERFLOW,
  EPERM,
  EPIPE,
  EPROTO,
  EPROTONOSUPPORT,
  EPROTOTYPE,
  ERANGE,
  EROFS,
  ESPIPE,
  ESRCH,
  ESTALE,
  ETIME,
  ETIMEDOUT,
  ETXTBSY,
  EWOULDBLOCK,
  EXDEV,
  F_OK,
  OPENSSL_VERSION_NUMBER,
  O_APPEND,
  O_CREAT,
  O_DIRECTORY,
  ...(O_DIRECT === undefined ? {} : { O_DIRECT }),
  O_DSYNC,
  O_EXCL,
  ...(O_NOATIME === undefined ? {} : { O_NOATIME }),
  O_NOCTTY,
  O_NOFOLLOW,
  O_NONBLOCK,
  O_RDONLY,
  O_RDWR,
  ...(O_SYMLINK === undefined ? {} : { O_SYMLINK }),
  O_SYNC,
  O_TRUNC,
  O_WRONLY,
  POINT_CONVERSION_COMPRESSED,
  POINT_CONVERSION_HYBRID,
  POINT_CONVERSION_UNCOMPRESSED,
  PRIORITY_ABOVE_NORMAL,
  PRIORITY_BELOW_NORMAL,
  PRIORITY_HIGH,
  PRIORITY_HIGHEST,
  PRIORITY_LOW,
  PRIORITY_NORMAL,
  RSA_NO_PADDING,
  RSA_PKCS1_OAEP_PADDING,
  RSA_PKCS1_PADDING,
  RSA_PKCS1_PSS_PADDING,
  RSA_PSS_SALTLEN_AUTO,
  RSA_PSS_SALTLEN_DIGEST,
  RSA_PSS_SALTLEN_MAX_SIGN,
  RSA_X931_PADDING,
  ...(RTLD_DEEPBIND === undefined ? {} : { RTLD_DEEPBIND }),
  RTLD_GLOBAL,
  RTLD_LAZY,
  RTLD_LOCAL,
  RTLD_NOW,
  R_OK,
  SIGABRT,
  SIGALRM,
  SIGBUS,
  SIGCHLD,
  SIGCONT,
  SIGFPE,
  SIGHUP,
  SIGILL,
  ...(SIGINFO === undefined ? {} : { SIGINFO }),
  SIGINT,
  SIGIO,
  SIGIOT,
  SIGKILL,
  SIGPIPE,
  ...(SIGPOLL === undefined ? {} : { SIGPOLL }),
  SIGPROF,
  ...(SIGPWR === undefined ? {} : { SIGPWR }),
  SIGQUIT,
  SIGSEGV,
  ...(SIGSTKFLT === undefined ? {} : { SIGSTKFLT }),
  SIGSTOP,
  SIGSYS,
  SIGTERM,
  SIGTRAP,
  SIGTSTP,
  SIGTTIN,
  SIGTTOU,
  SIGURG,
  SIGUSR1,
  SIGUSR2,
  SIGVTALRM,
  SIGWINCH,
  SIGXCPU,
  SIGXFSZ,
  SSL_OP_ALL,
  SSL_OP_ALLOW_NO_DHE_KEX,
  SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
  SSL_OP_CIPHER_SERVER_PREFERENCE,
  SSL_OP_CISCO_ANYCONNECT,
  SSL_OP_COOKIE_EXCHANGE,
  SSL_OP_CRYPTOPRO_TLSEXT_BUG,
  SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS,
  SSL_OP_LEGACY_SERVER_CONNECT,
  SSL_OP_NO_COMPRESSION,
  SSL_OP_NO_ENCRYPT_THEN_MAC,
  SSL_OP_NO_QUERY_MTU,
  SSL_OP_NO_RENEGOTIATION,
  SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION,
  SSL_OP_NO_SSLv2,
  SSL_OP_NO_SSLv3,
  SSL_OP_NO_TICKET,
  SSL_OP_NO_TLSv1,
  SSL_OP_NO_TLSv1_1,
  SSL_OP_NO_TLSv1_2,
  SSL_OP_NO_TLSv1_3,
  SSL_OP_PRIORITIZE_CHACHA,
  SSL_OP_TLS_ROLLBACK_BUG,
  S_IFBLK,
  S_IFCHR,
  S_IFDIR,
  S_IFIFO,
  S_IFLNK,
  S_IFMT,
  S_IFREG,
  S_IFSOCK,
  S_IRGRP,
  S_IROTH,
  S_IRUSR,
  S_IRWXG,
  S_IRWXO,
  S_IRWXU,
  S_IWGRP,
  S_IWOTH,
  S_IWUSR,
  S_IXGRP,
  S_IXOTH,
  S_IXUSR,
  TLS1_1_VERSION,
  TLS1_2_VERSION,
  TLS1_3_VERSION,
  TLS1_VERSION,
  UV_DIRENT_BLOCK,
  UV_DIRENT_CHAR,
  UV_DIRENT_DIR,
  UV_DIRENT_FIFO,
  UV_DIRENT_FILE,
  UV_DIRENT_LINK,
  UV_DIRENT_SOCKET,
  UV_DIRENT_UNKNOWN,
  UV_FS_COPYFILE_EXCL,
  UV_FS_COPYFILE_FICLONE,
  UV_FS_COPYFILE_FICLONE_FORCE,
  UV_FS_O_FILEMAP,
  UV_FS_SYMLINK_DIR,
  UV_FS_SYMLINK_JUNCTION,
  W_OK,
  X_OK,
  defaultCoreCipherList,
});
