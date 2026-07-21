import { expect, test } from "bun:test";

test("Response concatenates arrays of Uint8Array body parts", async () => {
  const backing = new TextEncoder().encode("xalpha-y");
  const first = backing.subarray(1, 6);
  const second = new TextEncoder().encode(" beta");
  const parts = [first, second];
  const response = new Response(parts as any);

  backing.fill(0);
  parts.push(new TextEncoder().encode(" ignored"));

  expect(await response.text()).toBe("alpha beta");
  const offsetBacking = new TextEncoder().encode("xgamma-y");
  const offsetResponse = new Response([offsetBacking.subarray(1, 6), new TextEncoder().encode(" delta")] as any);
  expect(new TextDecoder().decode(await offsetResponse.arrayBuffer())).toBe("gamma delta");
  expect(await new Response([] as any).text()).toBe("");
});
