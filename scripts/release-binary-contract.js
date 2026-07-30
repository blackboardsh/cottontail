const machoMagic64LittleEndian = 0xfeedfacf;
const machoSymtab = 0x2;
const machoDysymtab = 0xb;
const elfStaticSymbolTable = 2;
const elfDynamicSymbolTable = 11;
const elfUndefinedSection = 0;
const elfGlobalBinding = 1;
const elfWeakBinding = 2;
const elfGnuUniqueBinding = 10;
const elfDefaultVisibility = 0;
const elfHiddenVisibility = 2;
const elfProtectedVisibility = 3;
const elfVisibilityMask = 3;
const maximumMachOSymbols = 50_000;
const maximumMachOLocalSymbols = 4_096;
const maximumMachOSymbolStringBytes = 2 * 1024 * 1024;

export function elfExportSymbolsFromVersionScript(source) {
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : String(source);
  const symbols = [];
  let section = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === 'global:') {
      section = 'global';
      continue;
    }
    if (line === 'local:') {
      section = 'local';
      continue;
    }
    if (section !== 'global' || line === '' || line === '{' || line === '};') continue;

    const match = line.match(/^([^;\s]+)\s*;$/);
    if (!match || match[1].includes('*')) {
      throw new Error(`Unsupported ELF export entry: ${JSON.stringify(line)}`);
    }
    symbols.push(match[1]);
  }

  if (symbols.length === 0) {
    throw new Error('ELF version script does not contain any global symbols');
  }
  return symbols;
}

export function peExportSymbolsFromModuleDefinition(source) {
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : String(source);
  const symbols = [];
  let inExports = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/;.*$/, '').trim();
    if (line === '') continue;
    if (!inExports) {
      if (line.toUpperCase() === 'EXPORTS') inExports = true;
      continue;
    }
    if (/[\s=@]/.test(line)) {
      throw new Error(`Unsupported PE export entry: ${JSON.stringify(line)}`);
    }
    symbols.push(line);
  }

  if (!inExports || symbols.length === 0) {
    throw new Error('PE module definition does not contain any exported symbols');
  }
  return symbols;
}

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

function readCString(buffer, offset, limit, label) {
  if (offset < 0 || offset >= limit || limit > buffer.length) {
    throw new Error(`Malformed release binary: ${label} is out of range`);
  }
  const end = buffer.indexOf(0, offset);
  if (end === -1 || end >= limit) {
    throw new Error(`Malformed release binary: ${label} is not null terminated`);
  }
  return buffer.toString('utf8', offset, end);
}

function machoSymbolMetadata(buffer) {
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
        offset: buffer.readUInt32LE(offset + 8),
        total: buffer.readUInt32LE(offset + 12),
        stringOffset: buffer.readUInt32LE(offset + 16),
        stringBytes: buffer.readUInt32LE(offset + 20),
      };
    } else if (command === machoDysymtab) {
      requireRange(buffer, offset, 32, 'Mach-O dynamic symbol table command');
      dynamicSymbols = {
        local: buffer.readUInt32LE(offset + 12),
        externalDefinedIndex: buffer.readUInt32LE(offset + 16),
        externalDefined: buffer.readUInt32LE(offset + 20),
        undefined: buffer.readUInt32LE(offset + 28),
      };
    }
    offset += commandSize;
  }

  if (!symbols || !dynamicSymbols) {
    throw new Error('Malformed release binary: Mach-O symbol metadata is missing');
  }
  return { symbols, dynamicSymbols };
}

function inspectMachO(buffer) {
  const { symbols, dynamicSymbols } = machoSymbolMetadata(buffer);
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

function listMachOExportedSymbols(buffer) {
  const { symbols, dynamicSymbols } = machoSymbolMetadata(buffer);
  const symbolEntryBytes = 16;
  const first = dynamicSymbols.externalDefinedIndex;
  const count = dynamicSymbols.externalDefined;
  requireRange(
    buffer,
    symbols.offset,
    symbols.total * symbolEntryBytes,
    'Mach-O symbol table',
  );
  requireRange(
    buffer,
    symbols.stringOffset,
    symbols.stringBytes,
    'Mach-O symbol strings',
  );
  if (first + count > symbols.total) {
    throw new Error('Malformed release binary: Mach-O exported-symbol range is invalid');
  }

  const stringLimit = symbols.stringOffset + symbols.stringBytes;
  const result = [];
  for (let index = first; index < first + count; index += 1) {
    const entryOffset = symbols.offset + index * symbolEntryBytes;
    const stringIndex = buffer.readUInt32LE(entryOffset);
    if (stringIndex === 0) continue;
    result.push(readCString(
      buffer,
      symbols.stringOffset + stringIndex,
      stringLimit,
      `Mach-O symbol ${index}`,
    ));
  }
  return result;
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

function elfSectionMetadata(buffer) {
  requireRange(buffer, 0, 64, 'ELF header');
  if (buffer[4] !== 2 || buffer[5] !== 1) {
    throw new Error('Unsupported release binary: expected a little-endian ELF64 executable');
  }
  const offset = readUint64LittleEndian(buffer, 40, 'ELF section table offset');
  const entrySize = buffer.readUInt16LE(58);
  const count = buffer.readUInt16LE(60);
  if (entrySize < 64 || count === 0) {
    throw new Error('Malformed release binary: ELF section table is missing');
  }
  requireRange(buffer, offset, entrySize * count, 'ELF section table');
  return { offset, entrySize, count };
}

function readElfSection(buffer, sections, index, label) {
  if (index < 0 || index >= sections.count) {
    throw new Error(`Malformed release binary: ${label} index is invalid`);
  }
  const offset = sections.offset + index * sections.entrySize;
  return {
    type: buffer.readUInt32LE(offset + 4),
    offset: readUint64LittleEndian(buffer, offset + 24, `${label} offset`),
    size: readUint64LittleEndian(buffer, offset + 32, `${label} size`),
    link: buffer.readUInt32LE(offset + 40),
    entrySize: readUint64LittleEndian(buffer, offset + 56, `${label} entry size`),
  };
}

function visitElfDefinedDynamicSymbols(buffer, visitor) {
  const sections = elfSectionMetadata(buffer);
  for (let index = 0; index < sections.count; index += 1) {
    const symbols = readElfSection(buffer, sections, index, `ELF section ${index}`);
    if (symbols.type !== elfDynamicSymbolTable) continue;
    if (symbols.entrySize < 24 || symbols.size % symbols.entrySize !== 0) {
      throw new Error('Malformed release binary: ELF dynamic symbol table has invalid entries');
    }
    requireRange(buffer, symbols.offset, symbols.size, 'ELF dynamic symbol table');

    const strings = readElfSection(buffer, sections, symbols.link, 'ELF dynamic strings');
    requireRange(buffer, strings.offset, strings.size, 'ELF dynamic strings');
    const stringLimit = strings.offset + strings.size;
    const symbolCount = symbols.size / symbols.entrySize;
    for (let symbolIndex = 0; symbolIndex < symbolCount; symbolIndex += 1) {
      const entryOffset = symbols.offset + symbolIndex * symbols.entrySize;
      const binding = buffer[entryOffset + 4] >> 4;
      const visibility = buffer[entryOffset + 5] & elfVisibilityMask;
      const sectionIndex = buffer.readUInt16LE(entryOffset + 6);
      const stringIndex = buffer.readUInt32LE(entryOffset);
      if (
        stringIndex === 0 ||
        sectionIndex === elfUndefinedSection ||
        (
          binding !== elfGlobalBinding &&
          binding !== elfWeakBinding &&
          binding !== elfGnuUniqueBinding
        )
      ) {
        continue;
      }
      visitor({
        binding,
        entryOffset,
        name: readCString(
          buffer,
          strings.offset + stringIndex,
          stringLimit,
          `ELF dynamic symbol ${symbolIndex}`,
        ),
        visibility,
      });
    }
  }
}

function isExternallyVisibleElfSymbol(visibility) {
  return visibility === elfDefaultVisibility || visibility === elfProtectedVisibility;
}

function listElfExportedSymbols(buffer) {
  const result = [];
  visitElfDefinedDynamicSymbols(buffer, ({ name, visibility }) => {
    if (isExternallyVisibleElfSymbol(visibility)) result.push(name);
  });
  return result;
}

export function restrictElfDynamicExports(source, allowedSymbols) {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const allowed = allowedSymbols instanceof Set ? allowedSymbols : new Set(allowedSymbols);
  let hiddenSymbols = 0;
  let exposedSymbols = 0;
  let retainedSymbols = 0;

  visitElfDefinedDynamicSymbols(buffer, ({ entryOffset, name, visibility }) => {
    const isAllowed = allowed.has(name);
    const isVisible = isExternallyVisibleElfSymbol(visibility);
    if (isAllowed === isVisible) {
      if (isAllowed) retainedSymbols += 1;
      return;
    }

    const other = buffer[entryOffset + 5];
    if (isAllowed) {
      buffer[entryOffset + 5] = (other & ~elfVisibilityMask) | elfDefaultVisibility;
      exposedSymbols += 1;
    } else {
      buffer[entryOffset + 5] = (other & ~elfVisibilityMask) | elfHiddenVisibility;
      hiddenSymbols += 1;
    }
  });

  return {
    buffer,
    exposedSymbols,
    hiddenSymbols,
    retainedSymbols,
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

function portableExecutableExportMetadata(buffer) {
  requireRange(buffer, 0, 64, 'PE DOS header');
  const peOffset = buffer.readUInt32LE(0x3c);
  requireRange(buffer, peOffset, 24, 'PE header');
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error('Malformed release binary: PE signature is missing');
  }

  const coffOffset = peOffset + 4;
  const sectionCount = buffer.readUInt16LE(coffOffset + 2);
  const optionalHeaderBytes = buffer.readUInt16LE(coffOffset + 16);
  const optionalOffset = coffOffset + 20;
  requireRange(buffer, optionalOffset, optionalHeaderBytes, 'PE optional header');
  if (buffer.readUInt16LE(optionalOffset) !== 0x20b || optionalHeaderBytes < 120) {
    throw new Error('Unsupported release binary: expected a PE32+ executable');
  }

  const exportRva = buffer.readUInt32LE(optionalOffset + 112);
  const exportBytes = buffer.readUInt32LE(optionalOffset + 116);
  if (exportRva === 0 || exportBytes === 0) return null;

  const sectionOffset = optionalOffset + optionalHeaderBytes;
  requireRange(buffer, sectionOffset, sectionCount * 40, 'PE section table');
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionOffset + index * 40;
    sections.push({
      virtualSize: buffer.readUInt32LE(offset + 8),
      virtualAddress: buffer.readUInt32LE(offset + 12),
      rawSize: buffer.readUInt32LE(offset + 16),
      rawOffset: buffer.readUInt32LE(offset + 20),
    });
  }

  const rvaToOffset = (rva, label) => {
    const section = sections.find(({ virtualAddress, virtualSize, rawSize }) => (
      rva >= virtualAddress &&
      rva < virtualAddress + Math.max(virtualSize, rawSize)
    ));
    if (!section) {
      throw new Error(`Malformed release binary: ${label} RVA is not mapped`);
    }
    const sectionOffset = rva - section.virtualAddress;
    if (sectionOffset >= section.rawSize) {
      throw new Error(`Malformed release binary: ${label} RVA has no file data`);
    }
    const offset = section.rawOffset + sectionOffset;
    requireRange(buffer, offset, 1, label);
    return offset;
  };

  const directoryOffset = rvaToOffset(exportRva, 'PE export directory');
  requireRange(buffer, directoryOffset, 40, 'PE export directory');
  const functionCount = buffer.readUInt32LE(directoryOffset + 20);
  const nameCount = buffer.readUInt32LE(directoryOffset + 24);
  const nameArrayRva = buffer.readUInt32LE(directoryOffset + 32);
  const ordinalArrayRva = buffer.readUInt32LE(directoryOffset + 36);
  if (nameCount === 0) {
    return {
      directoryOffset,
      functionCount,
      nameArrayOffset: null,
      nameCount,
      ordinalArrayOffset: null,
      rvaToOffset,
    };
  }
  const nameArrayOffset = rvaToOffset(nameArrayRva, 'PE export name array');
  const ordinalArrayOffset = rvaToOffset(ordinalArrayRva, 'PE export ordinal array');
  requireRange(buffer, nameArrayOffset, nameCount * 4, 'PE export name array');
  requireRange(buffer, ordinalArrayOffset, nameCount * 2, 'PE export ordinal array');

  return {
    directoryOffset,
    functionCount,
    nameArrayOffset,
    nameCount,
    ordinalArrayOffset,
    rvaToOffset,
  };
}

function listPortableExecutableExports(buffer) {
  const metadata = portableExecutableExportMetadata(buffer);
  if (metadata === null) return [];
  const result = [];
  for (let index = 0; index < metadata.nameCount; index += 1) {
    const nameRva = buffer.readUInt32LE(metadata.nameArrayOffset + index * 4);
    const nameOffset = metadata.rvaToOffset(nameRva, `PE export name ${index}`);
    const ordinal = buffer.readUInt16LE(metadata.ordinalArrayOffset + index * 2);
    if (ordinal >= metadata.functionCount) {
      throw new Error(`Malformed release binary: PE export ordinal ${index} is invalid`);
    }
    result.push(readCString(buffer, nameOffset, buffer.length, `PE export name ${index}`));
  }
  return result;
}

export function restrictPortableExecutableExports(source, allowedSymbols) {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const metadata = portableExecutableExportMetadata(buffer);
  if (metadata === null) {
    return { buffer, hiddenSymbols: 0, retainedSymbols: 0 };
  }

  const allowed = allowedSymbols instanceof Set ? allowedSymbols : new Set(allowedSymbols);
  let hiddenSymbols = 0;
  let retainedSymbols = 0;
  for (let index = 0; index < metadata.nameCount; index += 1) {
    const nameRva = buffer.readUInt32LE(metadata.nameArrayOffset + index * 4);
    const nameOffset = metadata.rvaToOffset(nameRva, `PE export name ${index}`);
    const name = readCString(buffer, nameOffset, buffer.length, `PE export name ${index}`);
    const ordinal = buffer.readUInt16LE(metadata.ordinalArrayOffset + index * 2);
    if (ordinal >= metadata.functionCount) {
      throw new Error(`Malformed release binary: PE export ordinal ${index} is invalid`);
    }

    if (!allowed.has(name)) {
      hiddenSymbols += 1;
      continue;
    }
    buffer.writeUInt32LE(nameRva, metadata.nameArrayOffset + retainedSymbols * 4);
    buffer.writeUInt16LE(ordinal, metadata.ordinalArrayOffset + retainedSymbols * 2);
    retainedSymbols += 1;
  }
  buffer.writeUInt32LE(retainedSymbols, metadata.directoryOffset + 24);

  return { buffer, hiddenSymbols, retainedSymbols };
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

export function listExportedSymbols(source) {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
  requireRange(buffer, 0, 4, 'file header');

  if (buffer.readUInt32LE(0) === machoMagic64LittleEndian) {
    return listMachOExportedSymbols(buffer);
  }
  if (
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46
  ) {
    return listElfExportedSymbols(buffer);
  }
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return listPortableExecutableExports(buffer);
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
