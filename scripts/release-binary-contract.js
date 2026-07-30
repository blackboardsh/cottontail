const machoMagic64LittleEndian = 0xfeedfacf;
const machoSymtab = 0x2;
const machoDysymtab = 0xb;
const elfStaticSymbolTable = 2;
const maximumMachOSymbols = 50_000;
const maximumMachOLocalSymbols = 4_096;
const maximumMachOSymbolStringBytes = 2 * 1024 * 1024;

function requireRange(buffer, offset, size, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset + size > buffer.length
  ) {
    throw new Error(`Malformed release binary: ${label} is out of range`);
  }
}

function readUint64LittleEndian(buffer, offset, label) {
  requireRange(buffer, offset, 8, label);
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Malformed release binary: ${label} exceeds JavaScript's safe integer range`);
  }
  return Number(value);
}

function inspectMachO(buffer) {
  requireRange(buffer, 0, 32, 'Mach-O header');
  const commandCount = buffer.readUInt32LE(16);
  const commandBytes = buffer.readUInt32LE(20);
  requireRange(buffer, 32, commandBytes, 'Mach-O load commands');

  let offset = 32;
  let symbols = null;
  let dynamicSymbols = null;
  for (let index = 0; index < commandCount; index += 1) {
    requireRange(buffer, offset, 8, `Mach-O load command ${index}`);
    const command = buffer.readUInt32LE(offset);
    const commandSize = buffer.readUInt32LE(offset + 4);
    if (commandSize < 8) {
      throw new Error(`Malformed release binary: Mach-O load command ${index} is too small`);
    }
    requireRange(buffer, offset, commandSize, `Mach-O load command ${index}`);

    if (command === machoSymtab) {
      requireRange(buffer, offset, 24, 'Mach-O symbol table command');
      symbols = {
        total: buffer.readUInt32LE(offset + 12),
        stringBytes: buffer.readUInt32LE(offset + 20),
      };
    } else if (command === machoDysymtab) {
      requireRange(buffer, offset, 32, 'Mach-O dynamic symbol table command');
      dynamicSymbols = {
        local: buffer.readUInt32LE(offset + 12),
        externalDefined: buffer.readUInt32LE(offset + 20),
        undefined: buffer.readUInt32LE(offset + 28),
      };
    }
    offset += commandSize;
  }

  if (!symbols || !dynamicSymbols) {
    throw new Error('Malformed release binary: Mach-O symbol metadata is missing');
  }
  return {
    format: 'mach-o',
    stripped:
      symbols.total <= maximumMachOSymbols &&
      dynamicSymbols.local <= maximumMachOLocalSymbols &&
      symbols.stringBytes <= maximumMachOSymbolStringBytes,
    symbols: symbols.total,
    localSymbols: dynamicSymbols.local,
    externalDefinedSymbols: dynamicSymbols.externalDefined,
    undefinedSymbols: dynamicSymbols.undefined,
    symbolStringBytes: symbols.stringBytes,
  };
}

function inspectElf(buffer) {
  requireRange(buffer, 0, 64, 'ELF header');
  if (buffer[4] !== 2 || buffer[5] !== 1) {
    throw new Error('Unsupported release binary: expected a little-endian ELF64 executable');
  }

  const sectionOffset = readUint64LittleEndian(buffer, 40, 'ELF section table offset');
  const sectionEntrySize = buffer.readUInt16LE(58);
  const sectionCount = buffer.readUInt16LE(60);
  if (sectionEntrySize < 64 || sectionCount === 0) {
    throw new Error('Malformed release binary: ELF section table is missing');
  }
  requireRange(
    buffer,
    sectionOffset,
    sectionEntrySize * sectionCount,
    'ELF section table',
  );

  let staticSymbolTables = 0;
  let staticSymbolBytes = 0;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionOffset + index * sectionEntrySize;
    if (buffer.readUInt32LE(offset + 4) !== elfStaticSymbolTable) continue;
    staticSymbolTables += 1;
    staticSymbolBytes += readUint64LittleEndian(
      buffer,
      offset + 32,
      `ELF symbol table ${index} size`,
    );
  }
  return {
    format: 'elf64',
    stripped: staticSymbolTables === 0,
    staticSymbolTables,
    staticSymbolBytes,
  };
}

function inspectPortableExecutable(buffer) {
  requireRange(buffer, 0, 64, 'PE DOS header');
  const peOffset = buffer.readUInt32LE(0x3c);
  requireRange(buffer, peOffset, 24, 'PE header');
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error('Malformed release binary: PE signature is missing');
  }

  const coffOffset = peOffset + 4;
  const symbolTableOffset = buffer.readUInt32LE(coffOffset + 8);
  const symbols = buffer.readUInt32LE(coffOffset + 12);
  return {
    format: 'pe',
    stripped: symbolTableOffset === 0 && symbols === 0,
    symbols,
    symbolTableOffset,
  };
}

export function inspectReleaseBinary(source) {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
  requireRange(buffer, 0, 4, 'file header');

  if (buffer.readUInt32LE(0) === machoMagic64LittleEndian) {
    return inspectMachO(buffer);
  }
  if (
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46
  ) {
    return inspectElf(buffer);
  }
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return inspectPortableExecutable(buffer);
  }
  throw new Error('Unsupported release binary format');
}

export function assertStrippedReleaseBinary(source) {
  const result = inspectReleaseBinary(source);
  if (result.stripped) return result;

  if (result.format === 'mach-o') {
    throw new Error(
      `Mach-O executable retains an oversized symbol table: ` +
        `${result.symbols} entries, ${result.localSymbols} local symbols, ` +
        `${result.symbolStringBytes} symbol-string bytes`,
    );
  }
  if (result.format === 'elf64') {
    throw new Error(
      `ELF executable contains ${result.staticSymbolTables} static symbol table(s) ` +
        `using ${result.staticSymbolBytes} bytes`,
    );
  }
  throw new Error(
    `PE executable contains ${result.symbols} COFF symbols at offset ${result.symbolTableOffset}`,
  );
}
