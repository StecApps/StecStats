import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import { and, eq, or } from "drizzle-orm";
import { db, gamesTable, playersTable } from "@workspace/db";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { ObjectPermission } from "../lib/objectAcl";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 */
router.post("/storage/uploads/request-url", requireAuth, async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType } = parsed.data;

    const uploadURL = await objectStorageService.getObjectEntityUploadURL(req.appUser!.id);
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
router.get("/storage/objects/*path", requireAuth, async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    const ownerId = req.appUser!.id;

    // Prefer the authoritative DB ownership link (covers legacy objects that
    // predate ACL metadata being written), falling back to ACL metadata.
    const ownedGame = await db.query.gamesTable.findFirst({
      where: and(
        eq(gamesTable.ownerId, ownerId),
        or(
          eq(gamesTable.videoObjectPath, objectPath),
          eq(gamesTable.highlightObjectPath, objectPath),
        ),
      ),
    });

    // Player tracking photos are also stored as private objects.
    const ownedPlayerPhoto = !ownedGame
      ? await db.query.playersTable.findFirst({
          where: and(
            eq(playersTable.ownerId, ownerId),
            eq(playersTable.photoObjectPath, objectPath),
          ),
        })
      : null;

    const canAccess =
      !!ownedGame ||
      !!ownedPlayerPhoto ||
      (await objectStorageService.canAccessObjectEntity({
        userId: String(ownerId),
        objectFile,
        requestedPermission: ObjectPermission.READ,
      }));
    if (!canAccess) {
      res.status(404).json({ error: "Object not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    // When explicitly requested (e.g. the "Download" button), force a
    // Content-Disposition: attachment header. The HTML `download` anchor
    // attribute alone is unreliable — iOS Safari in particular ignores it
    // for video content and just opens/plays the file instead of saving it.
    const downloadName = typeof req.query.download === "string" ? req.query.download : null;
    if (downloadName) {
      res.setHeader("Content-Disposition", `attachment; filename="${downloadName.replace(/"/g, "")}"`);
    }

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
