const internalIncomingMessageFields = [
  "body",
  "deferBody",
  "headers",
  "highWaterMark",
  "httpVersion",
  "method",
  "rawHeaders",
  "rawTrailers",
  "statusCode",
  "statusMessage",
  "trailers",
  "url",
];

export function normalizeIncomingMessageArgument(value) {
  if (value !== null && typeof value === "object") {
    for (const field of internalIncomingMessageFields) {
      if (Object.prototype.hasOwnProperty.call(value, field)) return value;
    }
  }

  // The public Node constructor receives a socket, including null. Such a
  // message remains open until the parser or an interceptor supplies a body.
  return { socket: value, deferBody: true };
}
