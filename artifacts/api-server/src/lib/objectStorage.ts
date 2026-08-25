import { Storage, File } from "@google-cloud/storage";
import { Readable, pipeline as streamPipeline } from "stream";
import { createReadStream } from "fs";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

const pipeline = promisify(streamPipeline);

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const DIRECT_UPLOAD_URL_TTL_SEC = 30;

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  /**
   * Last-line write barrier for all private account upload paths. Route-level
   * auth stops new requests, but an in-flight encoder can reach this method
   * after deletion begins, so the durable owner state is checked immediately
   * before creating the GCS write stream.
   */
  private async assertOwnerUploadWritable(ownerId: number): Promise<void> {
    const owner = await db.query.usersTable.findFirst({
      where: eq(usersTable.id, ownerId),
      columns: { deletionStatus: true },
    });
    if (!owner || owner.deletionStatus !== "active") {
      throw new Error("Account deletion is in progress; object upload cancelled");
    }
  }

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(file: File, cacheTtlSec: number = 3600): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(ownerId: number): Promise<string> {
    // This is the single authoritative expiry for both the database
    // reservation and the signed URL. If issuance stalls past this moment,
    // the client receives an expired capability rather than one that could
    // outlive account deletion's final namespace sweep.
    const expiresAt = new Date(Date.now() + DIRECT_UPLOAD_URL_TTL_SEC * 1000);
    // Reserving the short-lived upload capability with an active-status
    // condition closes the race with account deletion. Once deletion marks the
    // row as deleting, no new capability can be issued; deletion then waits
    // for this recorded capability to expire before its namespace sweep.
    const [reserved] = await db
      .update(usersTable)
      .set({ pendingUploadExpiresAt: expiresAt })
      .where(and(eq(usersTable.id, ownerId), eq(usersTable.deletionStatus, "active")))
      .returning({ id: usersTable.id });
    if (!reserved) {
      throw new Error("Account deletion is in progress; object upload cancelled");
    }
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const objectId = randomUUID();
    // Namespace uploads per account so paths are segregated on disk, not
    // just gated by the ACL/DB-linkage checks layered on top.
    const fullPath = `${privateObjectDir}/uploads/${ownerId}/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    // Atomically claim the object slot with an owner ACL *before* returning
    // the signed URL to the client.  This means the object is already
    // ownership-tagged even during the window between URL issuance and the
    // client's actual PUT (or if the game row is never saved).
    //
    // Note: a plain GCS signed PUT will clear custom metadata when the
    // client uploads the real file, so GET /storage/objects/* also uses a
    // path-based ownership check (see storage.ts) as a complementary guard
    // that requires no live metadata.
    try {
      await file.save(Buffer.alloc(0), {
        metadata: { contentType: "application/octet-stream" },
        resumable: false,
      });
      await setObjectAclPolicy(file, {
        owner: String(ownerId),
        visibility: "private",
      });
      // Deletion may have begun while the placeholder was being created. Do
      // not return a signed PUT capability in that case; remove the temporary
      // object even if the deletion sweep has already passed this namespace.
      await this.assertOwnerUploadWritable(ownerId);
    } catch (err) {
      await file.delete().catch(() => {});
      throw err;
    }

    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      expiresAt,
    });
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async getObjectEntitySignedURL(objectPath: string, ttlSec: number = 3600): Promise<string> {
    const objectFile = await this.getObjectEntityFile(objectPath);
    return signObjectURL({
      bucketName: objectFile.bucket.name,
      objectName: objectFile.name,
      method: "GET",
      expiresAt: new Date(Date.now() + ttlSec * 1000),
    });
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }

  /**
   * Upload a local file to object storage by streaming it directly through
   * the GCS SDK (no full-file buffering in memory — safe for large videos).
   * Returns the normalized /objects/... path.
   */
  async uploadLocalFileAsObjectEntity(
    localPath: string,
    ownerId: number,
    contentType: string,
  ): Promise<string> {
    await this.assertOwnerUploadWritable(ownerId);
    const privateObjectDir = this.getPrivateObjectDir();
    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${ownerId}/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    await pipeline(
      createReadStream(localPath),
      file.createWriteStream({ metadata: { contentType }, resumable: false }),
    );

    return `/objects/uploads/${ownerId}/${objectId}`;
  }

  /**
   * Check whether an object entity exists without throwing.
   * Returns false for any non-existent path; re-throws non-existence errors.
   */
  async checkObjectEntityExists(objectPath: string): Promise<boolean> {
    try {
      await this.getObjectEntityFile(objectPath);
      return true;
    } catch (err) {
      if (err instanceof ObjectNotFoundError) return false;
      throw err;
    }
  }

  /**
   * Upload a local file to the requested object-storage entity.
   * objectEntityPath must be of the form /objects/uploads/{ownerId}/{name}.
   */
  async uploadLocalFileToObjectPath(
    localPath: string,
    objectEntityPath: string,
    contentType: string,
  ): Promise<void> {
    if (!objectEntityPath.startsWith("/objects/")) {
      throw new Error(`uploadLocalFileToObjectPath: path must start with /objects/, got ${objectEntityPath}`);
    }
    const entityId = objectEntityPath.slice("/objects/".length);
    const ownerMatch = entityId.match(/^uploads\/(\d+)\//);
    if (ownerMatch) {
      await this.assertOwnerUploadWritable(Number(ownerMatch[1]));
    }
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
    const fullPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    await pipeline(
      createReadStream(localPath),
      file.createWriteStream({ metadata: { contentType }, resumable: false }),
    );
  }

  /**
   * Delete an object entity from GCS by its /objects/... path.
   * If the object does not exist this is a no-op (idempotent).
   */
  async deleteObjectEntity(objectPath: string): Promise<void> {
    if (!objectPath.startsWith("/objects/")) return;
    const entityId = objectPath.slice("/objects/".length);
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
    const fullPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    try {
      await file.delete();
    } catch (err: any) {
      // 404 means the blob is already gone — treat as success.
      if (err?.code === 404 || err?.message?.includes("No such object")) return;
      throw err;
    }
  }

  /**
   * Remove every object in an account's private upload namespace. Account
   * deletion uses this in addition to removing paths referenced by database
   * rows, so abandoned uploads and intermediate video chunks are not retained.
   */
  async deleteOwnerUploadNamespace(ownerId: number): Promise<void> {
    const privateObjectDir = this.getPrivateObjectDir();
    const { bucketName, objectName: privatePrefix } = parseObjectPath(privateObjectDir);
    const prefixBase = privatePrefix.replace(/\/+$/, "");
    const prefix = `${prefixBase}/uploads/${ownerId}/`;
    const bucket = objectStorageClient.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix });

    await Promise.all(
      files.map(async (file) => {
        try {
          await file.delete();
        } catch (err: any) {
          // A concurrent cleanup may already have removed the file.
          if (err?.code === 404 || err?.message?.includes("No such object")) return;
          throw err;
        }
      }),
    );
  }

  /**
   * Delete every object below a private /objects/... prefix. Used when an
   * account is permanently deleted to remove abandoned uploads as well as the
   * media paths still referenced by database rows.
   */
  async deleteObjectEntityPrefix(objectPrefix: string): Promise<void> {
    if (!objectPrefix.startsWith("/objects/")) return;
    const entityId = objectPrefix.slice("/objects/".length);
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
    const fullPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix: objectName });

    for (const file of files) {
      try {
        await file.delete();
      } catch (err: any) {
        if (err?.code !== 404 && !err?.message?.includes("No such object")) {
          throw err;
        }
      }
    }
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  expiresAt,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  expiresAt: Date;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: expiresAt.toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`
    );
  }

  const { signed_url: signedURL } = (await response.json()) as { signed_url: string };
  return signedURL;
}
