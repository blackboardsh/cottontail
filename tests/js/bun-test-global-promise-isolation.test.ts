import { afterAll, expect, test } from "bun:test";

const NativePromise = globalThis.Promise;

function UserPromise<T>(executor?: ConstructorParameters<PromiseConstructor>[0]): Promise<T> {
  if (executor === undefined) return NativePromise.resolve(undefined as T);
  return new NativePromise<T>(executor);
}

UserPromise.prototype = NativePromise.prototype;
Object.assign(UserPromise, NativePromise);
globalThis.Promise = UserPromise as unknown as PromiseConstructor;

afterAll(() => {
  globalThis.Promise = NativePromise;
});

test("bun:test orchestration is isolated from a replaced global Promise", async () => {
  await NativePromise.resolve();
  expect(globalThis.Promise).toBe(UserPromise);
});
