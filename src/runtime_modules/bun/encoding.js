// WHATWG Encoding Standard implementation: TextEncoder + TextDecoder.
// https://encoding.spec.whatwg.org/
//
// UTF-8, UTF-16LE/BE, windows-1252 and the other WPT-exercised single-byte
// encodings are decoded in JS with spec index tables (the tables below are the
// WHATWG indexes). Legacy CJK encodings (and the remaining rarely-used
// single-byte encodings) are decoded through the system ICU converters via
// cottontail.icuDecode when available.

const g = globalThis;

// ---------------------------------------------------------------------------
// Labels (https://encoding.spec.whatwg.org/#names-and-labels)
// ---------------------------------------------------------------------------

const ENCODING_LABELS = {
  "utf-8": ["unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "utf-8", "utf8", "x-unicode20utf8"],
  "ibm866": ["866", "cp866", "csibm866", "ibm866"],
  "iso-8859-2": ["csisolatin2", "iso-8859-2", "iso-ir-101", "iso8859-2", "iso88592", "iso_8859-2", "iso_8859-2:1987", "l2", "latin2"],
  "iso-8859-3": ["csisolatin3", "iso-8859-3", "iso-ir-109", "iso8859-3", "iso88593", "iso_8859-3", "iso_8859-3:1988", "l3", "latin3"],
  "iso-8859-4": ["csisolatin4", "iso-8859-4", "iso-ir-110", "iso8859-4", "iso88594", "iso_8859-4", "iso_8859-4:1988", "l4", "latin4"],
  "iso-8859-5": ["csisolatincyrillic", "cyrillic", "iso-8859-5", "iso-ir-144", "iso8859-5", "iso88595", "iso_8859-5", "iso_8859-5:1988"],
  "iso-8859-6": ["arabic", "asmo-708", "csiso88596e", "csiso88596i", "csisolatinarabic", "ecma-114", "iso-8859-6", "iso-8859-6-e", "iso-8859-6-i", "iso-ir-127", "iso8859-6", "iso88596", "iso_8859-6", "iso_8859-6:1987"],
  "iso-8859-7": ["csisolatingreek", "ecma-118", "elot_928", "greek", "greek8", "iso-8859-7", "iso-ir-126", "iso8859-7", "iso88597", "iso_8859-7", "iso_8859-7:1987", "sun_eu_greek"],
  "iso-8859-8": ["csiso88598e", "csisolatinhebrew", "hebrew", "iso-8859-8", "iso-8859-8-e", "iso-ir-138", "iso8859-8", "iso88598", "iso_8859-8", "iso_8859-8:1988", "visual"],
  "iso-8859-8-i": ["csiso88598i", "iso-8859-8-i", "logical"],
  "iso-8859-10": ["csisolatin6", "iso-8859-10", "iso-ir-157", "iso8859-10", "iso885910", "l6", "latin6"],
  "iso-8859-13": ["iso-8859-13", "iso8859-13", "iso885913"],
  "iso-8859-14": ["iso-8859-14", "iso8859-14", "iso885914"],
  "iso-8859-15": ["csisolatin9", "iso-8859-15", "iso8859-15", "iso885915", "iso_8859-15", "l9"],
  "iso-8859-16": ["iso-8859-16"],
  "koi8-r": ["cskoi8r", "koi", "koi8", "koi8-r", "koi8_r"],
  "koi8-u": ["koi8-ru", "koi8-u"],
  "macintosh": ["csmacintosh", "mac", "macintosh", "x-mac-roman"],
  "windows-874": ["dos-874", "iso-8859-11", "iso8859-11", "iso885911", "tis-620", "windows-874"],
  "windows-1250": ["cp1250", "windows-1250", "x-cp1250"],
  "windows-1251": ["cp1251", "windows-1251", "x-cp1251"],
  "windows-1252": ["ansi_x3.4-1968", "ascii", "cp1252", "cp819", "csisolatin1", "ibm819", "iso-8859-1", "iso-ir-100", "iso8859-1", "iso88591", "iso_8859-1", "iso_8859-1:1987", "l1", "latin1", "us-ascii", "windows-1252", "x-cp1252"],
  "windows-1253": ["cp1253", "windows-1253", "x-cp1253"],
  "windows-1254": ["cp1254", "csisolatin5", "iso-8859-9", "iso-ir-148", "iso8859-9", "iso88599", "iso_8859-9", "iso_8859-9:1989", "l5", "latin5", "windows-1254", "x-cp1254"],
  "windows-1255": ["cp1255", "windows-1255", "x-cp1255"],
  "windows-1256": ["cp1256", "windows-1256", "x-cp1256"],
  "windows-1257": ["cp1257", "windows-1257", "x-cp1257"],
  "windows-1258": ["cp1258", "windows-1258", "x-cp1258"],
  "x-mac-cyrillic": ["x-mac-cyrillic", "x-mac-ukrainian"],
  "gbk": ["chinese", "csgb2312", "csiso58gb231280", "gb2312", "gb_2312", "gb_2312-80", "gbk", "iso-ir-58", "x-gbk"],
  "gb18030": ["gb18030"],
  "big5": ["big5", "big5-hkscs", "cn-big5", "csbig5", "x-x-big5"],
  "euc-jp": ["cseucpkdfmtjapanese", "euc-jp", "x-euc-jp"],
  "iso-2022-jp": ["csiso2022jp", "iso-2022-jp"],
  "shift_jis": ["csshiftjis", "ms932", "ms_kanji", "shift-jis", "shift_jis", "sjis", "windows-31j", "x-sjis"],
  "euc-kr": ["cseuckr", "csksc56011987", "euc-kr", "iso-ir-149", "korean", "ks_c_5601-1987", "ks_c_5601-1989", "ksc5601", "ksc_5601", "windows-949"],
  "replacement": ["csiso2022kr", "hz-gb-2312", "iso-2022-cn", "iso-2022-cn-ext", "iso-2022-kr", "replacement"],
  "utf-16be": ["unicodefffe", "utf-16be"],
  "utf-16le": ["csunicode", "iso-10646-ucs-2", "ucs-2", "unicode", "unicodefeff", "utf-16", "utf-16le"],
  "x-user-defined": ["x-user-defined"],
};

const LABEL_TO_ENCODING = new Map();
for (const name of Object.keys(ENCODING_LABELS)) {
  for (const label of ENCODING_LABELS[name]) LABEL_TO_ENCODING.set(label, name);
}

function lookupEncoding(label) {
  const text = String(label).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").toLowerCase();
  const name = LABEL_TO_ENCODING.get(text);
  if (name === undefined) {
    const error = new RangeError(`ERR_ENCODING_NOT_SUPPORTED: The "${label}" encoding is not supported`);
    error.code = "ERR_ENCODING_NOT_SUPPORTED";
    throw error;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Single-byte index tables (WHATWG indexes; -1 marks an undefined pointer)
// ---------------------------------------------------------------------------

const SINGLE_BYTE_TABLES = {
  "ibm866": [1040,1041,1042,1043,1044,1045,1046,1047,1048,1049,1050,1051,1052,1053,1054,1055,1056,1057,1058,1059,1060,1061,1062,1063,1064,1065,1066,1067,1068,1069,1070,1071,1072,1073,1074,1075,1076,1077,1078,1079,1080,1081,1082,1083,1084,1085,1086,1087,9617,9618,9619,9474,9508,9569,9570,9558,9557,9571,9553,9559,9565,9564,9563,9488,9492,9524,9516,9500,9472,9532,9566,9567,9562,9556,9577,9574,9568,9552,9580,9575,9576,9572,9573,9561,9560,9554,9555,9579,9578,9496,9484,9608,9604,9612,9616,9600,1088,1089,1090,1091,1092,1093,1094,1095,1096,1097,1098,1099,1100,1101,1102,1103,1025,1105,1028,1108,1031,1111,1038,1118,176,8729,183,8730,8470,164,9632,160],
  "iso-8859-3": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,294,728,163,164,-1,292,167,168,304,350,286,308,173,-1,379,176,295,178,179,180,181,293,183,184,305,351,287,309,189,-1,380,192,193,194,-1,196,266,264,199,200,201,202,203,204,205,206,207,-1,209,210,211,212,288,214,215,284,217,218,219,220,364,348,223,224,225,226,-1,228,267,265,231,232,233,234,235,236,237,238,239,-1,241,242,243,244,289,246,247,285,249,250,251,252,365,349,729],
  "iso-8859-6": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,-1,-1,-1,164,-1,-1,-1,-1,-1,-1,-1,1548,173,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1563,-1,-1,-1,1567,-1,1569,1570,1571,1572,1573,1574,1575,1576,1577,1578,1579,1580,1581,1582,1583,1584,1585,1586,1587,1588,1589,1590,1591,1592,1593,1594,-1,-1,-1,-1,-1,1600,1601,1602,1603,1604,1605,1606,1607,1608,1609,1610,1611,1612,1613,1614,1615,1616,1617,1618,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  "iso-8859-7": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,8216,8217,163,8364,8367,166,167,168,169,890,171,172,173,-1,8213,176,177,178,179,900,901,902,183,904,905,906,187,908,189,910,911,912,913,914,915,916,917,918,919,920,921,922,923,924,925,926,927,928,929,-1,931,932,933,934,935,936,937,938,939,940,941,942,943,944,945,946,947,948,949,950,951,952,953,954,955,956,957,958,959,960,961,962,963,964,965,966,967,968,969,970,971,972,973,974,-1],
  "iso-8859-8": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,-1,162,163,164,165,166,167,168,169,215,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,247,187,188,189,190,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,8215,1488,1489,1490,1491,1492,1493,1494,1495,1496,1497,1498,1499,1500,1501,1502,1503,1504,1505,1506,1507,1508,1509,1510,1511,1512,1513,1514,-1,-1,8206,8207,-1],
  "koi8-u": [9472,9474,9484,9488,9492,9496,9500,9508,9516,9524,9532,9600,9604,9608,9612,9616,9617,9618,9619,8992,9632,8729,8730,8776,8804,8805,160,8993,176,178,183,247,9552,9553,9554,1105,1108,9556,1110,1111,9559,9560,9561,9562,9563,1169,1118,9566,9567,9568,9569,1025,1028,9571,1030,1031,9574,9575,9576,9577,9578,1168,1038,169,1102,1072,1073,1094,1076,1077,1092,1075,1093,1080,1081,1082,1083,1084,1085,1086,1087,1103,1088,1089,1090,1091,1078,1074,1100,1099,1079,1096,1101,1097,1095,1098,1070,1040,1041,1062,1044,1045,1060,1043,1061,1048,1049,1050,1051,1052,1053,1054,1055,1071,1056,1057,1058,1059,1046,1042,1068,1067,1047,1064,1069,1065,1063,1066],
  "windows-874": [8364,129,130,131,132,8230,134,135,136,137,138,139,140,141,142,143,144,8216,8217,8220,8221,8226,8211,8212,152,153,154,155,156,157,158,159,160,3585,3586,3587,3588,3589,3590,3591,3592,3593,3594,3595,3596,3597,3598,3599,3600,3601,3602,3603,3604,3605,3606,3607,3608,3609,3610,3611,3612,3613,3614,3615,3616,3617,3618,3619,3620,3621,3622,3623,3624,3625,3626,3627,3628,3629,3630,3631,3632,3633,3634,3635,3636,3637,3638,3639,3640,3641,3642,-1,-1,-1,-1,3647,3648,3649,3650,3651,3652,3653,3654,3655,3656,3657,3658,3659,3660,3661,3662,3663,3664,3665,3666,3667,3668,3669,3670,3671,3672,3673,3674,3675,-1,-1,-1,-1],
  "windows-1252": [8364,129,8218,402,8222,8230,8224,8225,710,8240,352,8249,338,141,381,143,144,8216,8217,8220,8221,8226,8211,8212,732,8482,353,8250,339,157,382,376,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255],
  "windows-1253": [8364,129,8218,402,8222,8230,8224,8225,136,8240,138,8249,140,141,142,143,144,8216,8217,8220,8221,8226,8211,8212,152,8482,154,8250,156,157,158,159,160,901,902,163,164,165,166,167,168,169,-1,171,172,173,174,8213,176,177,178,179,900,181,182,183,904,905,906,187,908,189,910,911,912,913,914,915,916,917,918,919,920,921,922,923,924,925,926,927,928,929,-1,931,932,933,934,935,936,937,938,939,940,941,942,943,944,945,946,947,948,949,950,951,952,953,954,955,956,957,958,959,960,961,962,963,964,965,966,967,968,969,970,971,972,973,974,-1],
  "windows-1255": [8364,129,8218,402,8222,8230,8224,8225,710,8240,138,8249,140,141,142,143,144,8216,8217,8220,8221,8226,8211,8212,732,8482,154,8250,156,157,158,159,160,161,162,163,8362,165,166,167,168,169,215,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,247,187,188,189,190,191,1456,1457,1458,1459,1460,1461,1462,1463,1464,1465,1466,1467,1468,1469,1470,1471,1472,1473,1474,1475,1520,1521,1522,1523,1524,-1,-1,-1,-1,-1,-1,-1,1488,1489,1490,1491,1492,1493,1494,1495,1496,1497,1498,1499,1500,1501,1502,1503,1504,1505,1506,1507,1508,1509,1510,1511,1512,1513,1514,-1,-1,8206,8207,-1],
  "windows-1257": [8364,129,8218,131,8222,8230,8224,8225,136,8240,138,8249,140,168,711,184,144,8216,8217,8220,8221,8226,8211,8212,152,8482,154,8250,156,175,731,159,160,-1,162,163,164,-1,166,167,216,169,342,171,172,173,174,198,176,177,178,179,180,181,182,183,248,185,343,187,188,189,190,230,260,302,256,262,196,197,280,274,268,201,377,278,290,310,298,315,352,323,325,211,332,213,214,215,370,321,346,362,220,379,381,223,261,303,257,263,228,229,281,275,269,233,378,279,291,311,299,316,353,324,326,243,333,245,246,247,371,322,347,363,252,380,382,729],
};

// Encodings decoded through ICU (converter name per encoding).
const ICU_DECODERS = {
  "shift_jis": "windows-31j",
  "euc-jp": "euc-jp",
  "iso-2022-jp": "ISO-2022-JP",
  "big5": "big5",
  "euc-kr": "windows-949",
  "gbk": "gb18030",
  "gb18030": "gb18030",
};

// Rare single-byte encodings whose tables we derive from ICU at first use.
const ICU_SINGLE_BYTE = {
  "iso-8859-2": "iso-8859-2",
  "iso-8859-4": "iso-8859-4",
  "iso-8859-5": "iso-8859-5",
  "iso-8859-10": "iso-8859-10",
  "iso-8859-13": "iso-8859-13",
  "iso-8859-14": "iso-8859-14",
  "iso-8859-15": "iso-8859-15",
  "iso-8859-16": "iso-8859-16",
  "koi8-r": "koi8-r",
  "macintosh": "macintosh",
  "windows-1250": "windows-1250",
  "windows-1251": "windows-1251",
  "windows-1254": "windows-1254",
  "windows-1256": "windows-1256",
  "windows-1258": "windows-1258",
  "x-mac-cyrillic": "x-mac-cyrillic",
};

// iso-8859-8-i shares iso-8859-8's index.
SINGLE_BYTE_TABLES["iso-8859-8-i"] = SINGLE_BYTE_TABLES["iso-8859-8"];

const icuTableCache = new Map();

function nativeIcuDecode(converterName, bytes, fatal) {
  const host = g.cottontail;
  if (host == null || typeof host.icuDecode !== "function") return null;
  return host.icuDecode(converterName, bytes, fatal);
}

function singleByteTable(name) {
  const embedded = SINGLE_BYTE_TABLES[name];
  if (embedded !== undefined) return embedded;
  let table = icuTableCache.get(name);
  if (table !== undefined) return table;
  table = new Array(128);
  let decoded = null;
  const probe = new Uint8Array(128);
  for (let i = 0; i < 128; i++) probe[i] = 0x80 + i;
  try {
    decoded = nativeIcuDecode(ICU_SINGLE_BYTE[name], probe, false);
  } catch {
    decoded = null;
  }
  if (typeof decoded === "string" && decoded.length === 128) {
    for (let i = 0; i < 128; i++) {
      const code = decoded.charCodeAt(i);
      table[i] = code === 0xfffd ? -1 : code;
    }
  } else {
    // ICU unavailable: degrade to an identity mapping.
    for (let i = 0; i < 128; i++) table[i] = 0x80 + i;
  }
  icuTableCache.set(name, table);
  return table;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const EMPTY_BYTES = new Uint8Array(0);

function makeDecodeError(encoding) {
  const error = new TypeError(
    `The encoded data was not valid for encoding ${encoding}`,
  );
  error.code = "ERR_ENCODING_INVALID_ENCODED_DATA";
  return error;
}

function coerceDecodeInput(input, encoding) {
  if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && input instanceof SharedArrayBuffer)) {
    try {
      return new Uint8Array(input);
    } catch {
      return EMPTY_BYTES; // detached
    }
  }
  if (ArrayBuffer.isView(input)) {
    try {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } catch {
      return EMPTY_BYTES; // detached
    }
  }
  const error = new TypeError(
    `The "input" argument must be an instance of ArrayBuffer or ArrayBufferView. Received ${input === null ? "null" : typeof input}`,
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  throw error;
}

// TextDecoderOptions flag conversion. Bun rejects values whose boolean-ness is
// ambiguous (objects, numbers other than 0/1); everything else coerces.
function coerceDecoderFlag(value, name) {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 0) return false;
    if (value === 1) return true;
    throw new TypeError(`TextDecoder option "${name}" must be a boolean`);
  }
  if (typeof value === "object" || typeof value === "function") {
    throw new TypeError(`TextDecoder option "${name}" must be a boolean`);
  }
  return Boolean(value);
}

function codesToString(codes) {
  const length = codes.length;
  if (length === 0) return "";
  if (length <= 8192) return String.fromCharCode.apply(null, codes);
  let result = "";
  for (let i = 0; i < length; i += 8192) {
    result += String.fromCharCode.apply(null, codes.slice(i, i + 8192));
  }
  return result;
}

function codesToUtf16String(codes) {
  if (codes.length === 0) return "";
  if (typeof g.cottontail?.stringFromUtf16 === "function") {
    return g.cottontail.stringFromUtf16(new Uint16Array(codes));
  }
  return codesToString(codes);
}

function concatChunks(chunks) {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// TextDecoder
// ---------------------------------------------------------------------------

const KIND_UTF8 = 0;
const KIND_UTF16LE = 1;
const KIND_UTF16BE = 2;
const KIND_SINGLE_BYTE = 3;
const KIND_X_USER_DEFINED = 4;
const KIND_REPLACEMENT = 5;
const KIND_ICU = 6;

function encodingKind(name) {
  if (name === "utf-8") return KIND_UTF8;
  if (name === "utf-16le") return KIND_UTF16LE;
  if (name === "utf-16be") return KIND_UTF16BE;
  if (name === "x-user-defined") return KIND_X_USER_DEFINED;
  if (name === "replacement") return KIND_REPLACEMENT;
  if (ICU_DECODERS[name] !== undefined) return KIND_ICU;
  return KIND_SINGLE_BYTE;
}

function resetStreamState(state) {
  state.bomSeen = false;
  state.u8cp = 0;
  state.u8needed = 0;
  state.u8seen = 0;
  state.u8lower = 0x80;
  state.u8upper = 0xbf;
  state.leadByte = -1;
  state.leadSurrogate = 0;
  state.replacementErrored = false;
  state.pending = null;
}

class TextDecoder {
  constructor(label = "utf-8", options = undefined) {
    const name = lookupEncoding(label === undefined ? "utf-8" : label);
    let fatal = false;
    let ignoreBOM = false;
    if (options !== undefined && options !== null) {
      fatal = coerceDecoderFlag(options.fatal, "fatal");
      ignoreBOM = coerceDecoderFlag(options.ignoreBOM, "ignoreBOM");
    }
    this.encoding = name;
    this.fatal = fatal;
    this.ignoreBOM = ignoreBOM;
    const state = {
      kind: encodingKind(name),
      table: null,
      icuName: ICU_DECODERS[name],
      doNotFlush: false,
    };
    if (state.kind === KIND_SINGLE_BYTE) state.table = singleByteTable(name);
    resetStreamState(state);
    Object.defineProperty(this, "_state", { value: state, writable: true, enumerable: false, configurable: true });
  }

  decode(input = undefined, options = undefined) {
    const state = this._state;
    if (!state.doNotFlush) resetStreamState(state);
    const bytes = input === undefined ? EMPTY_BYTES : coerceDecodeInput(input, this.encoding);
    let stream = false;
    if (options !== undefined && options !== null) stream = Boolean(options.stream);
    state.doNotFlush = stream;
    const flush = !stream;

    switch (state.kind) {
      case KIND_UTF8:
        return this.#finishText(state, this.#decodeUTF8(state, bytes, flush), true);
      case KIND_UTF16LE:
      case KIND_UTF16BE:
        return this.#finishText(state, this.#decodeUTF16(state, bytes, flush, state.kind === KIND_UTF16BE), true, true);
      case KIND_SINGLE_BYTE:
        return this.#decodeSingleByte(state, bytes);
      case KIND_X_USER_DEFINED:
        return this.#decodeXUserDefined(bytes);
      case KIND_REPLACEMENT:
        return this.#decodeReplacement(state, bytes);
      case KIND_ICU:
        return this.#decodeICU(state, bytes, flush);
    }
    return "";
  }

  #finishText(state, result, checkBOM, forceUtf16 = false) {
    // Fast paths return strings directly (BOM already accounted for).
    if (typeof result === "string") return result;
    if (checkBOM && !this.ignoreBOM && !state.bomSeen && result.length > 0) {
      state.bomSeen = true;
      if (result[0] === 0xfeff) result.shift();
    } else if (result.length > 0) {
      state.bomSeen = true;
    }
    return forceUtf16 ? codesToUtf16String(result) : codesToString(result);
  }

  #decodeUTF8(state, bytes, flush) {
    const length = bytes.length;
    // Fast path: no partial sequence pending and pure ASCII input.
    if (state.u8needed === 0) {
      let ascii = true;
      for (let i = 0; i < length; i++) {
        if (bytes[i] > 0x7f) {
          ascii = false;
          break;
        }
      }
      if (ascii) {
        if (length > 0) state.bomSeen = true;
        return codesToString(bytes);
      }
    }
    const out = [];
    let cp = state.u8cp;
    let needed = state.u8needed;
    let seen = state.u8seen;
    let lower = state.u8lower;
    let upper = state.u8upper;
    const fatal = this.fatal;
    for (let i = 0; i < length; i++) {
      const b = bytes[i];
      if (needed === 0) {
        if (b <= 0x7f) {
          out.push(b);
          continue;
        }
        if (b >= 0xc2 && b <= 0xdf) {
          needed = 1;
          cp = b & 0x1f;
        } else if (b >= 0xe0 && b <= 0xef) {
          if (b === 0xe0) lower = 0xa0;
          if (b === 0xed) upper = 0x9f;
          needed = 2;
          cp = b & 0xf;
        } else if (b >= 0xf0 && b <= 0xf4) {
          if (b === 0xf0) lower = 0x90;
          if (b === 0xf4) upper = 0x8f;
          needed = 3;
          cp = b & 0x7;
        } else {
          if (fatal) {
            this.#resetUTF8(state);
            throw makeDecodeError(this.encoding);
          }
          out.push(0xfffd);
        }
        continue;
      }
      if (b < lower || b > upper) {
        cp = 0;
        needed = 0;
        seen = 0;
        lower = 0x80;
        upper = 0xbf;
        if (fatal) {
          this.#resetUTF8(state);
          throw makeDecodeError(this.encoding);
        }
        out.push(0xfffd);
        i -= 1; // prepend byte to the stream and reprocess it
        continue;
      }
      lower = 0x80;
      upper = 0xbf;
      cp = (cp << 6) | (b & 0x3f);
      seen += 1;
      if (seen === needed) {
        if (cp <= 0xffff) {
          out.push(cp);
        } else {
          const v = cp - 0x10000;
          out.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
        }
        cp = 0;
        needed = 0;
        seen = 0;
      }
    }
    if (flush && needed !== 0) {
      cp = 0;
      needed = 0;
      seen = 0;
      lower = 0x80;
      upper = 0xbf;
      if (fatal) {
        this.#resetUTF8(state);
        throw makeDecodeError(this.encoding);
      }
      out.push(0xfffd);
    }
    state.u8cp = cp;
    state.u8needed = needed;
    state.u8seen = seen;
    state.u8lower = lower;
    state.u8upper = upper;
    return out;
  }

  #resetUTF8(state) {
    state.u8cp = 0;
    state.u8needed = 0;
    state.u8seen = 0;
    state.u8lower = 0x80;
    state.u8upper = 0xbf;
  }

  #decodeUTF16(state, bytes, flush, bigEndian) {
    const out = [];
    let leadByte = state.leadByte;
    let leadSurrogate = state.leadSurrogate;
    const fatal = this.fatal;
    const fail = () => {
      state.leadByte = -1;
      state.leadSurrogate = 0;
      throw makeDecodeError(this.encoding);
    };
    const length = bytes.length;
    for (let i = 0; i < length; i++) {
      const b = bytes[i];
      if (leadByte < 0) {
        leadByte = b;
        continue;
      }
      let unit = bigEndian ? (leadByte << 8) | b : leadByte | (b << 8);
      leadByte = -1;
      if (leadSurrogate !== 0) {
        if (unit >= 0xdc00 && unit <= 0xdfff) {
          out.push(leadSurrogate, unit);
          leadSurrogate = 0;
          continue;
        }
        leadSurrogate = 0;
        if (fatal) fail();
        out.push(0xfffd);
        // Reprocess the current unit below.
      }
      if (unit >= 0xd800 && unit <= 0xdbff) {
        leadSurrogate = unit;
        continue;
      }
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        if (fatal) fail();
        out.push(0xfffd);
        continue;
      }
      out.push(unit);
    }
    if (flush && (leadByte >= 0 || leadSurrogate !== 0)) {
      leadByte = -1;
      leadSurrogate = 0;
      if (fatal) fail();
      out.push(0xfffd);
    }
    state.leadByte = leadByte;
    state.leadSurrogate = leadSurrogate;
    return out;
  }

  #decodeSingleByte(state, bytes) {
    const table = state.table;
    const length = bytes.length;
    const out = new Array(length);
    let w = 0;
    for (let i = 0; i < length; i++) {
      const b = bytes[i];
      if (b < 0x80) {
        out[w++] = b;
        continue;
      }
      const code = table[b - 0x80];
      if (code === -1) {
        if (this.fatal) throw makeDecodeError(this.encoding);
        out[w++] = 0xfffd;
      } else {
        out[w++] = code;
      }
    }
    out.length = w;
    return codesToString(out);
  }

  #decodeXUserDefined(bytes) {
    const length = bytes.length;
    const out = new Array(length);
    for (let i = 0; i < length; i++) {
      const b = bytes[i];
      out[i] = b < 0x80 ? b : 0xf780 + b - 0x80;
    }
    return codesToString(out);
  }

  #decodeReplacement(state, bytes) {
    if (bytes.length === 0 || state.replacementErrored) return "";
    state.replacementErrored = true;
    if (this.fatal) throw makeDecodeError(this.encoding);
    return "�";
  }

  #decodeICU(state, bytes, flush) {
    if (bytes.length > 0) {
      if (state.pending === null) state.pending = [];
      state.pending.push(Uint8Array.prototype.slice.call(bytes));
    }
    if (!flush) return "";
    const chunks = state.pending;
    state.pending = null;
    if (chunks === null) return "";
    const total = concatChunks(chunks);
    if (total.length === 0) return "";
    let decoded;
    try {
      decoded = nativeIcuDecode(state.icuName, total, this.fatal);
    } catch {
      throw makeDecodeError(this.encoding);
    }
    if (decoded === null) {
      throw new Error(`TextDecoder: the "${this.encoding}" encoding requires ICU converter support, which is unavailable in this build`);
    }
    return decoded;
  }

  get [Symbol.toStringTag]() {
    return "TextDecoder";
  }
}

// ---------------------------------------------------------------------------
// TextEncoder
// ---------------------------------------------------------------------------

function utf8EncodeString(text) {
  const length = text.length;
  const out = new Uint8Array(length * 3);
  let w = 0;
  for (let i = 0; i < length; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x80) {
      out[w++] = c;
      continue;
    }
    if (c < 0x800) {
      out[w++] = 0xc0 | (c >> 6);
      out[w++] = 0x80 | (c & 0x3f);
      continue;
    }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
        out[w++] = 0xf0 | (cp >> 18);
        out[w++] = 0x80 | ((cp >> 12) & 0x3f);
        out[w++] = 0x80 | ((cp >> 6) & 0x3f);
        out[w++] = 0x80 | (cp & 0x3f);
        continue;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate
    out[w++] = 0xe0 | (c >> 12);
    out[w++] = 0x80 | ((c >> 6) & 0x3f);
    out[w++] = 0x80 | (c & 0x3f);
  }
  return out.slice(0, w);
}

class TextEncoder {
  constructor() {
    // No options per spec.
  }

  get encoding() {
    return "utf-8";
  }

  encode(input = "") {
    if (input === undefined) return new Uint8Array(0);
    return utf8EncodeString(String(input));
  }

  encodeInto(source, destination) {
    if (!(destination instanceof Uint8Array)) {
      const error = new TypeError('The "destination" argument must be an instance of Uint8Array');
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    const text = String(source);
    const capacity = destination.length;
    const length = text.length;
    let read = 0;
    let written = 0;
    for (let i = 0; i < length; i++) {
      const c = text.charCodeAt(i);
      let cp = c;
      let units = 1;
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = i + 1 < length ? text.charCodeAt(i + 1) : -1;
        if (next >= 0xdc00 && next <= 0xdfff) {
          cp = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
          units = 2;
        } else {
          cp = 0xfffd;
        }
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        cp = 0xfffd;
      }
      let size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (written + size > capacity) {
        if (units === 2) {
          // Not enough room for the full pair: fall back to a replacement
          // character for the lead surrogate alone (matches Bun).
          cp = 0xfffd;
          units = 1;
          size = 3;
          if (written + size <= capacity) {
            destination[written] = 0xe0 | (cp >> 12);
            destination[written + 1] = 0x80 | ((cp >> 6) & 0x3f);
            destination[written + 2] = 0x80 | (cp & 0x3f);
            written += 3;
            read += 1;
            continue;
          }
        }
        break;
      }
      if (cp < 0x80) {
        destination[written++] = cp;
      } else if (cp < 0x800) {
        destination[written++] = 0xc0 | (cp >> 6);
        destination[written++] = 0x80 | (cp & 0x3f);
      } else if (cp < 0x10000) {
        destination[written++] = 0xe0 | (cp >> 12);
        destination[written++] = 0x80 | ((cp >> 6) & 0x3f);
        destination[written++] = 0x80 | (cp & 0x3f);
      } else {
        destination[written++] = 0xf0 | (cp >> 18);
        destination[written++] = 0x80 | ((cp >> 12) & 0x3f);
        destination[written++] = 0x80 | ((cp >> 6) & 0x3f);
        destination[written++] = 0x80 | (cp & 0x3f);
      }
      read += units;
      if (units === 2) i += 1;
    }
    return { read, written };
  }

  get [Symbol.toStringTag]() {
    return "TextEncoder";
  }
}

g.TextEncoder = TextEncoder;
g.TextDecoder = TextDecoder;

export { TextEncoder, TextDecoder };
