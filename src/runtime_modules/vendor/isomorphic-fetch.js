const bunFetch = globalThis.Bun.fetch;
const fetch = (...args) => bunFetch(...args);
fetch.default = fetch;
fetch.fetch = fetch;

export { fetch };
export default fetch;
