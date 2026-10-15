import path from "path";
import multer from "multer";

/**
 * All uploads go to memory (req.file.buffer) and are pushed to Vercel Blob
 * by the service layer right after multer succeeds — nothing is ever
 * written to local disk. The backend runs as a Vercel serverless function,
 * whose filesystem is ephemeral, so disk storage never actually persisted
 * anything in production.
 */
const ALLOWED_LOGO_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);
const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

export const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_SIZE_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_LOGO_MIME_TYPES.has(file.mimetype)) {
      callback(new Error("Only PNG, JPEG, WEBP, or SVG logo files are allowed."));
      return;
    }
    callback(null, true);
  },
}).single("logo");

/**
 * In-memory (no disk write) storage for bulk-import CSVs — the file is
 * parsed once and discarded, never served back, so there is nothing to
 * persist for.
 */
const ALLOWED_CSV_MIME_TYPES = new Set(["text/csv", "application/vnd.ms-excel", "text/plain"]);
const MAX_CSV_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

export const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_SIZE_BYTES },
  fileFilter: (_req, file, callback) => {
    const hasCsvExtension = path.extname(file.originalname).toLowerCase() === ".csv";
    if (!ALLOWED_CSV_MIME_TYPES.has(file.mimetype) && !hasCsvExtension) {
      callback(new Error("Only .csv files are allowed."));
      return;
    }
    callback(null, true);
  },
}).single("file");

const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const ALLOWED_DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx"]);
const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

function documentFileFilter(
  _req: unknown,
  file: Express.Multer.File,
  callback: (error: Error | null, acceptFile?: boolean) => void
) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_DOCUMENT_MIME_TYPES.has(file.mimetype) && !ALLOWED_DOCUMENT_EXTENSIONS.has(extension)) {
    callback(new Error("Only PDF, DOC, or DOCX files are allowed."));
    return;
  }
  callback(null, true);
}

/** Budget Setup supporting documents (sanction letters, approval memos, etc.). */
export const uploadBudgetDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES },
  fileFilter: documentFileFilter,
}).single("document");

/** Budget Allocation reference documents — same constraints as Budget Setup's. */
export const uploadBudgetAllocationDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES },
  fileFilter: documentFileFilter,
}).single("document");

/** Expenditure bill/voucher reference documents — same constraints. */
export const uploadExpenditureDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES },
  fileFilter: documentFileFilter,
}).single("document");

/** Payroll batch supporting documents (sanction letters, payroll sheets, etc.). */
export const uploadPayrollDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES },
  fileFilter: documentFileFilter,
}).single("document");

/**
 * A user's own profile photo — same pattern as the branding logo, no SVG (a
 * profile photo is a raster image, never a vector).
 */
const ALLOWED_PROFILE_PHOTO_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_PROFILE_PHOTO_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

export const uploadProfilePhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PROFILE_PHOTO_SIZE_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_PROFILE_PHOTO_MIME_TYPES.has(file.mimetype)) {
      callback(new Error("Only PNG, JPEG, or WEBP photos are allowed."));
      return;
    }
    callback(null, true);
  },
}).single("photo");

/**
 * multer's fileFilter only sees the client-reported mimetype — every other
 * upload in this app stops there, but a profile photo is public-facing
 * (rendered in the header for everyone who can see this user), so it gets
 * one extra check nothing else here has: the real magic bytes of the
 * uploaded buffer, to catch a renamed/relabeled non-image slipping past the
 * mimetype check. Runs on the in-memory buffer before it's ever uploaded to
 * Blob, so a rejected file never leaves a trace anywhere.
 */
export function isValidImageSignature(buffer: Buffer, mimetype: string): boolean {
  if (buffer.length < 4) return false;

  if (mimetype === "image/png") {
    return buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }
  if (mimetype === "image/jpeg") {
    return buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  }
  if (mimetype === "image/webp") {
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}
