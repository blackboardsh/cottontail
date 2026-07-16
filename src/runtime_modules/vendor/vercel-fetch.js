export default function createVercelFetch(wrapper = globalThis.Bun.fetch) {
  async function vercelFetch(url, options = {}) {
    if (
      options.body &&
      typeof options.body === "object" &&
      (!("buffer" in options.body) ||
        typeof options.body.buffer !== "object" ||
        !(options.body.buffer instanceof ArrayBuffer))
    ) {
      options.body = JSON.stringify(options.body);
      if (!options.headers) options.headers = new Headers();
      options.headers.set("Content-Type", "application/json");
    }

    try {
      return await wrapper(url, options);
    } catch (error) {
      error.url = url;
      error.opts = options;
      throw error;
    }
  }

  vercelFetch.default = vercelFetch;
  return vercelFetch;
}
