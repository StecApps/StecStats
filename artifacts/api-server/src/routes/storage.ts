import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
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

    const [metadata] = await objectFile.getMetadata();
    const contentType: string = (metadata.contentType as string) || "application/octet-stream";
    const fileSize = Number(metadata.size ?? 0);

    const downloadName = typeof req.query.download === "string" ? req.query.download : null;
    if (downloadName) {
      res.setHeader("Content-Disposition", `attachment; filename="${downloadName.replace(/"/g, "")}"`);
    }

    // Always advertise range support so browsers know they can seek video.
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");

    const rangeHeader = req.headers["range"];
    if (rangeHeader && fileSize > 0) {
      // Parse "bytes=start-end" — end is optional (means "to EOF").
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (!match) {
        res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
        return;
      }
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      if (start > end || end >= fileSize) {
        res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
        return;
      }
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      res.setHeader("Content-Length", chunkSize);
      objectFile.createReadStream({ start, end }).pipe(res);
    } else {
      // Full file — send Content-Length so the browser can show progress.
      if (fileSize > 0) res.setHeader("Content-Length", fileSize);
      res.status(200);
      objectFile.createReadStream().pipe(res);
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

/**
 * POST /storage/concat-segments
 *
 * Accepts an ordered array of object-storage paths for video segments
 * (e.g. two halves recorded via "Start 2nd Half"), concatenates them into
 * a single valid MP4 using ffmpeg's concat demuxer (copy mode — no
 * re-encoding, fast), and stores the result as a new object.
 *
 * Raw Blob concatenation on the client produces invalid MP4 when two
 * separate iOS MediaRecorder sessions are merged; ffmpeg's concat demuxer
 * correctly adjusts the second segment's timestamps so they follow the
 * first, making all events seekable in one continuous video.
 */
router.post("/storage/concat-segments", requireAuth, async (req: Request, res: Response) => {
  const { segmentPaths } = req.body;

  if (!Array.isArray(segmentPaths) || segmentPaths.length < 2) {
    res.status(400).json({ error: "segmentPaths must be an array with at least 2 paths" });
    return;
  }
  if (segmentPaths.length > 6) {
    res.status(400).json({ error: "Too many segments (max 6)" });
    return;
  }

  const ownerId = req.appUser!.id;
  let tmpDir: string | null = null;

  try {
    // Get 2-hour signed read URLs so ffmpeg can stream directly from GCS
    const signedUrls: string[] = await Promise.all(
      (segmentPaths as string[]).map((p) =>
        objectStorageService.getObjectEntitySignedURL(p, 7200),
      ),
    );

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "concat-"));
    const fileListPath = path.join(tmpDir, "filelist.txt");
    // Single-quote each URL — GCS signed URLs never contain single quotes
    const fileListContent = signedUrls.map((u) => `file '${u}'`).join("\n");
    await fs.writeFile(fileListPath, fileListContent, "utf8");

    const outPath = path.join(tmpDir, "output.mp4");

    // Concat demuxer with -c copy: fast (no re-encoding), adjusts second
    // segment's timestamps to start at the end of the first segment.
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-f", "concat",
        "-safe", "0",
        "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
        "-i", fileListPath,
        "-c", "copy",
        "-movflags", "+faststart",
        "-y",
        outPath,
      ]);
      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
      });
      proc.on("error", reject);
    });

    const objectPath = await objectStorageService.uploadLocalFileAsObjectEntity(
      outPath,
      ownerId,
      "video/mp4",
    );

    await objectStorageService
      .trySetObjectEntityAclPolicy(objectPath, {
        owner: String(ownerId),
        visibility: "private",
      })
      .catch((err) => req.log.error({ err }, "Failed to set concat video ACL"));

    res.json({ videoObjectPath: objectPath });
  } catch (err) {
    req.log.error({ err }, "Failed to concatenate video segments");
    res.status(500).json({ error: "Failed to concatenate video segments" });
  } finally {
    if (tmpDir) {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

export default router;
