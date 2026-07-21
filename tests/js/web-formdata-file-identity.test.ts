import { expect, test } from "bun:test";

test("FormData wraps a named Blob as the public File type", async () => {
  const source = new Blob(["contents"], { type: "text/plain" });
  const form = new FormData();

  form.append("upload", source, "upload.txt");

  const upload = form.get("upload");
  expect(upload).toBeInstanceOf(File);
  expect(upload).toBeInstanceOf(Blob);
  expect((upload as File).name).toBe("upload.txt");
  expect((upload as File).type).toBe(source.type);
  expect(await (upload as File).text()).toBe("contents");
});
