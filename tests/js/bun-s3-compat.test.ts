import { S3Client } from "bun";
import { describe, expect, test } from "bun:test";

const credentials = {
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  region: "us-east-2",
  bucket: "test-bucket",
};

describe("Bun S3 compatibility", () => {
  test("list signs canonical options and parses S3 XML", async () => {
    let request: Request | undefined;
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        request = req;
        return new Response(
          `<ListBucketResult>
            <Name>test-bucket</Name>
            <IsTruncated>false</IsTruncated>
            <Contents>
              <Key>a&amp;b.txt</Key>
              <ETag>&quot;etag&quot;</ETag>
              <Size>12</Size>
              <Owner><ID>owner-id</ID></Owner>
              <StorageClass>STANDARD</StorageClass>
            </Contents>
          </ListBucketResult>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      },
    });

    const client = new S3Client({
      ...credentials,
      endpoint: server.url.href,
      requestPayer: true,
    });
    const result = await client.list({
      prefix: "some/folder&",
      fetchOwner: true,
      maxKeys: 10,
    });

    expect(new URL(request!.url).search).toBe(
      "?fetch-owner=true&list-type=2&max-keys=10&prefix=some%2Ffolder%26",
    );
    expect(request!.headers.get("x-amz-request-payer")).toBe("requester");
    expect(request!.headers.get("authorization")).toContain("x-amz-request-payer");
    expect(result).toEqual({
      name: "test-bucket",
      isTruncated: false,
      contents: [{
        key: "a&b.txt",
        eTag: '"etag"',
        size: 12,
        storageClass: "STANDARD",
        owner: { id: "owner-id" },
      }],
    });
  });

  test("writer performs a signed multipart upload", async () => {
    const requests: Array<{ method: string; url: URL; storageClass: string | null }> = [];
    using server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        requests.push({
          method: req.method,
          url,
          storageClass: req.headers.get("x-amz-storage-class"),
        });
        if (req.method === "POST" && url.searchParams.has("uploads")) {
          return new Response(
            "<InitiateMultipartUploadResult><UploadId>upload-id</UploadId></InitiateMultipartUploadResult>",
          );
        }
        if (req.method === "PUT") {
          await req.arrayBuffer();
          return new Response("", { headers: { etag: `part-${url.searchParams.get("partNumber")}` } });
        }
        if (req.method === "POST" && url.searchParams.has("uploadId")) {
          return new Response("<CompleteMultipartUploadResult />");
        }
        return new Response("unexpected request", { status: 400 });
      },
    });

    const client = new S3Client({ ...credentials, endpoint: server.url.href });
    const writer = client.file("multipart.bin").writer({
      partSize: 5 * 1024 * 1024,
      storageClass: "STANDARD_IA",
    });
    writer.write(new Uint8Array(5 * 1024 * 1024 + 1));
    await writer.end();

    expect(requests.map(({ method }) => method)).toEqual(["POST", "PUT", "PUT", "POST"]);
    expect(requests[0].url.search).toBe("?uploads=");
    expect(requests[0].storageClass).toBe("STANDARD_IA");
    expect(requests[1].url.searchParams.get("partNumber")).toBe("1");
    expect(requests[2].url.searchParams.get("partNumber")).toBe("2");
    expect(requests[3].url.searchParams.get("uploadId")).toBe("upload-id");
  });
});
