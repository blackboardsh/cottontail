export const performance = globalThis.performance ?? {
  now() {
    return Date.now();
  },
};

export default { performance };
