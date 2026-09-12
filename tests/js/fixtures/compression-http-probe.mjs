export const compressionEncodings = ["gzip", "deflate", "br", "zstd"];

export function equal(actual, expected) {
  if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

export async function probeHTTPCompression({ url, content }) {
  let responses = 0;
  let corruptResponsesRejected = 0;
  for (const encoding of compressionEncodings) {
    for (const streamed of [false, true]) {
      const response = await fetch(`${url}/${encoding}?${Date.now()}`, { signal: AbortSignal.timeout(8000) });
      equal(response.status, 200);
      equal(response.headers.get("content-encoding"), encoding);
      let text;
      if (streamed) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        text = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } else {
        text = await response.text();
      }
      equal(text, content);
      equal(response.bodyUsed, true);
      responses++;
    }
    let failure;
    try {
      const response = await fetch(`${url}/${encoding}?invalid=1`, { signal: AbortSignal.timeout(8000) });
      await response.text();
    } catch (error) {
      failure = error;
    }
    if (!/Decompression error:/.test(failure?.message ?? "")) throw new Error(`Expected ${encoding} decompression failure, received ${failure}`);
    corruptResponsesRejected++;
  }
  return { codecs: compressionEncodings, responses, corruptResponsesRejected };
}
