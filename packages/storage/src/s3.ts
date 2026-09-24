import { createHash } from "node:crypto";
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { OmniError } from "@omni/shared";
import { MAX_OBJECT_BYTES, type PutOptions, type Storage, type StoredObject } from "./port.js";

/**
 * Almacén compatible con S3: AWS, Cloudflare R2, Backblaze B2 o MinIO.
 *
 * El bucket debe ser PRIVADO. El acceso va siempre por URL firmada con
 * caducidad; un bucket público convertiría cada adjunto en una fuga a la
 * espera de que alguien comparta un enlace.
 */
export class S3Storage implements Storage {
  readonly kind = "s3" as const;
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(opts: {
    bucket: string; region?: string; endpoint?: string;
    accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean;
  }) {
    this.#bucket = opts.bucket;
    this.#client = new S3Client({
      region: opts.region ?? "auto",
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle ?? true,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async put(key: string, bytes: Uint8Array, opts: PutOptions): Promise<StoredObject> {
    if (bytes.byteLength > MAX_OBJECT_BYTES) {
      throw new OmniError("validation_failed", `el objeto supera el máximo de ${MAX_OBJECT_BYTES} bytes`, {
        size: bytes.byteLength, max: MAX_OBJECT_BYTES,
      });
    }
    await this.#client.send(new PutObjectCommand({
      Bucket: this.#bucket, Key: key, Body: bytes, ContentType: opts.mimeType,
      ...(opts.fileName ? { ContentDisposition: `attachment; filename="${opts.fileName}"` } : {}),
    }));
    return {
      key, size: bytes.byteLength, mimeType: opts.mimeType,
      checksum: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async get(key: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    try {
      const out = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      const bytes = await out.Body!.transformToByteArray();
      return { bytes, mimeType: out.ContentType ?? "application/octet-stream" };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.#client,
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }
}
