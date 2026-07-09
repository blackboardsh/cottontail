function notSea() {
  const error = new Error("Operation cannot be invoked when not in a single-executable application");
  error.code = "ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION";
  return error;
}

export function isSea() {
  return false;
}

export function getAssetKeys() {
  throw notSea();
}

export function getAsset(key, encoding = undefined) {
  void key;
  void encoding;
  throw notSea();
}

export function getRawAsset(key) {
  void key;
  throw notSea();
}

export function getAssetAsBlob(key, options = undefined) {
  void key;
  void options;
  throw notSea();
}

export default { getAsset, getAssetAsBlob, getAssetKeys, getRawAsset, isSea };
