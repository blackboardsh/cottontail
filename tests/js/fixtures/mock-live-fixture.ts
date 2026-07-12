import { rexported } from "./mock-live-source";

export function fn() {
  return 42;
}

export function iCallFn() {
  return fn();
}

export const variable = 7;
export { rexported };
