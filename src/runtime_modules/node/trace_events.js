const enabled = new Set();

function normalizeCategories(categories = []) {
  if (typeof categories === "string") return categories.split(",").map((item) => item.trim()).filter(Boolean);
  return Array.from(categories ?? [], String).filter(Boolean);
}

export function createTracing(options = {}) {
  const categories = normalizeCategories(options.categories);
  return {
    categories: categories.join(","),
    get enabled() {
      return categories.some((category) => enabled.has(category));
    },
    enable() {
      for (const category of categories) enabled.add(category);
    },
    disable() {
      for (const category of categories) enabled.delete(category);
    },
  };
}

export function getEnabledCategories() {
  return [...enabled].sort().join(",");
}

export default { createTracing, getEnabledCategories };
