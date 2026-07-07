export function randomBytes(size) {
  const bytes = new Uint8Array(Number(size) || 0);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

export default { randomBytes };
