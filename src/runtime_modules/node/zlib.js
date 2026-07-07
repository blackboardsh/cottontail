export function inflateSync(data) {
  const inflated = cottontail.inflateSync(data);
  return new Uint8Array(inflated);
}

export default { inflateSync };
