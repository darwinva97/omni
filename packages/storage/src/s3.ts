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
  /**
   * Firma las URLs que salen hacia fuera. Es el mismo cliente salvo que haya
   * `publicEndpoint`: con el almacén en la red interna (p. ej. un servicio de
   * Kubernetes), los bytes van por ahí, pero una URL firmada contra ese host no
   * la puede abrir nadie de fuera. La firma incluye el host, así que no basta
   * con reescribirlo después: hay que firmar contra el público.
   */
  readonly #signer: S3Client;
  readonly #bucket: string;
  /**
   * Carpeta dentro del bucket (p. ej. `whatsapp/`): así el mismo bucket guarda también otras
   * cosas (copias, imágenes) ordenadas. Las claves de fuera no la llevan: se pone y se quita aquí.
   */
  readonly #prefijo: string;

  constructor(opts: {
    bucket: string; region?: string; endpoint?: string; publicEndpoint?: string;
    accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean; prefix?: string;
  }) {
    this.#bucket = opts.bucket;
    const p = (opts.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.#prefijo = p ? `${p}/` : "";
    const client = (endpoint: string | undefined) => new S3Client({
      region: opts.region ?? "auto",
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: opts.forcePathStyle ?? true,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
    this.#client = client(opts.endpoint);
    this.#signer = opts.publicEndpoint ? client(opts.publicEndpoint) : this.#client;
  }

  async put(key: string, bytes: Uint8Array, opts: PutOptions): Promise<StoredObject> {
    if (bytes.byteLength > MAX_OBJECT_BYTES) {
      throw new OmniError("validation_failed", `el objeto supera el máximo de ${MAX_OBJECT_BYTES} bytes`, {
        size: bytes.byteLength, max: MAX_OBJECT_BYTES,
      });
    }
    await this.#client.send(new PutObjectCommand({
      Bucket: this.#bucket, Key: this.#prefijo + key, Body: bytes, ContentType: opts.mimeType,
      ...(opts.fileName ? { ContentDisposition: `attachment; filename="${opts.fileName}"` } : {}),
    }));
    return {
      key, size: bytes.byteLength, mimeType: opts.mimeType,
      checksum: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async get(key: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    try {
      const out = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: this.#prefijo + key }));
      const bytes = await out.Body!.transformToByteArray();
      return { bytes, mimeType: out.ContentType ?? "application/octet-stream" };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: this.#prefijo + key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: this.#prefijo + key }));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.#signer,
      new GetObjectCommand({ Bucket: this.#bucket, Key: this.#prefijo + key }),
      { expiresIn: ttlSeconds },
    );
  }
}
