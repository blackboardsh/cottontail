// Generated MIME data lives in compiler/http_types/MimeType.zig.
const mimeTypes = new Map();

function resolveMimeType(extension) {
  const result = cottontail.mimeTypeByExtension(extension);
  if (mimeTypes.size >= 128) mimeTypes.clear();
  mimeTypes.set(extension, result);
  return result;
}

export function bunFileMimeType(extension) {
  return mimeTypes.get(extension) ?? resolveMimeType(extension);
}
