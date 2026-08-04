export const bunFileLikeBrand = Symbol.for("cottontail.bunFileLike");

export function isBunFileLike(value) {
  if (!value || typeof value !== "object") return false;
  try {
    if (value[bunFileLikeBrand] === true) return true;
    return typeof value.arrayBuffer === "function" &&
      typeof value.text === "function" &&
      typeof value.exists === "function" &&
      (typeof value.writer === "function" || typeof value.write === "function");
  } catch {
    return false;
  }
}
