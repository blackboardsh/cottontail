const enabled = new Set();

function normalizeCategories(categories = []) {
  if (typeof categories === "string") return categories.split(",").map((item) => item.trim()).filter(Boolean);
  return Array.from(categories ?? [], String).filter(Boolean);
}

class Tracing {
  constructor(categories) {
    Object.defineProperty(this, "_categories", {
      value: categories,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    this.categories = categories.join(",");
  }

  get enabled() {
    return this._categories.some((category) => enabled.has(category));
  }

  enable() {
    for (const category of this._categories) enabled.add(category);
  }

  disable() {
    for (const category of this._categories) enabled.delete(category);
  }
}

export function createTracing(options = {}) {
  return new Tracing(normalizeCategories(options.categories));
}

export function getEnabledCategories() {
  return [...enabled].sort().join(",");
}

export default { createTracing, getEnabledCategories };
