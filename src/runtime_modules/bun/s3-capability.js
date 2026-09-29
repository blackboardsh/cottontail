// Use the capability instance shared by the runtime module loader.
const namespace = globalThis.Cottontail.s3;
export const { S3Client, s3, s3File } = namespace;
