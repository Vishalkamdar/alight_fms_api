import crypto from "crypto";
import path from "path";
import { put, del } from "@vercel/blob";

export interface UploadedBlob {
  url: string;
  storedFileName: string;
}

/**
 * Uploads a buffer to Vercel Blob under `<folder>/<storedFileName>`, where
 * storedFileName follows the same `<prefix>-<timestamp>-<randomhex><ext>`
 * convention the old multer.diskStorage `filename` callbacks used — some
 * attachment schemas declare `fileName` as required, so callers still need
 * a name even though nothing is written to disk anymore.
 */
export async function uploadToBlob(
  folder: string,
  prefix: string,
  originalName: string,
  buffer: Buffer,
  mimetype: string
): Promise<UploadedBlob> {
  const uniqueSuffix = crypto.randomBytes(8).toString("hex");
  const extension = path.extname(originalName).toLowerCase() || "";
  const storedFileName = `${prefix}-${Date.now()}-${uniqueSuffix}${extension}`;

  const blob = await put(`${folder}/${storedFileName}`, buffer, {
    access: "public",
    addRandomSuffix: false,
    contentType: mimetype,
  });

  return { url: blob.url, storedFileName };
}

/**
 * Best-effort delete, mirroring the swallow-and-log pattern every disk-unlink
 * call site used before this migration. Safe to call with a stale/legacy
 * (pre-migration, non-Blob `/uploads/...`) value or null — del() doesn't
 * throw on a URL it can't find.
 */
export async function deleteFromBlob(url: string | null | undefined): Promise<void> {
  if (!url) return;
  try {
    await del(url);
  } catch (error) {
    console.error("[blob-storage] failed to delete blob:", url, error);
  }
}
