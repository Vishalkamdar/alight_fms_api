import path from "path";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";

/**
 * Local-disk storage for uploaded branding assets, served statically by
 * Express (see app.ts). No external storage service is introduced — this
 * stays within the existing Node/Express stack.
 */
export const UPLOAD_ROOT_DIR = path.resolve(process.cwd(), "uploads");
const BRANDING_DIR = path.join(UPLOAD_ROOT_DIR, "branding");

fs.mkdirSync(BRANDING_DIR, { recursive: true });

const ALLOWED_LOGO_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);
const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, BRANDING_DIR);
  },
  filename: (_req, file, callback) => {
    const uniqueSuffix = crypto.randomBytes(8).toString("hex");
    const extension = path.extname(file.originalname).toLowerCase() || ".png";
    callback(null, `logo-${Date.now()}-${uniqueSuffix}${extension}`);
  },
});

export const uploadLogo = multer({
  storage,
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
 * persist to disk for.
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

/**
 * Disk storage for Budget Setup supporting documents (sanction letters,
 * approval memos, etc.) — served statically the same way as branding assets.
 */
const BUDGET_DOCUMENTS_DIR = path.join(UPLOAD_ROOT_DIR, "budget-setups");
fs.mkdirSync(BUDGET_DOCUMENTS_DIR, { recursive: true });

const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const ALLOWED_DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx"]);
const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

const budgetDocumentStorage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, BUDGET_DOCUMENTS_DIR);
  },
  filename: (_req, file, callback) => {
    const uniqueSuffix = crypto.randomBytes(8).toString("hex");
    const extension = path.extname(file.originalname).toLowerCase() || ".pdf";
    callback(null, `doc-${Date.now()}-${uniqueSuffix}${extension}`);
  },
});

export const uploadBudgetDocument = multer({
  storage: budgetDocumentStorage,
  limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_DOCUMENT_MIME_TYPES.has(file.mimetype) && !ALLOWED_DOCUMENT_EXTENSIONS.has(extension)) {
      callback(new Error("Only PDF, DOC, or DOCX files are allowed."));
      return;
    }
    callback(null, true);
  },
}).single("document");

/**
 * Disk storage for Budget Allocation reference documents (the same file
 * type/size constraints as Budget Setup's documents, kept in its own
 * directory so the two modules' uploads never collide by filename).
 */
const BUDGET_ALLOCATION_DOCUMENTS_DIR = path.join(UPLOAD_ROOT_DIR, "budget-allocations");
fs.mkdirSync(BUDGET_ALLOCATION_DOCUMENTS_DIR, { recursive: true });

const budgetAllocationDocumentStorage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, BUDGET_ALLOCATION_DOCUMENTS_DIR);
  },
  filename: (_req, file, callback) => {
    const uniqueSuffix = crypto.randomBytes(8).toString("hex");
    const extension = path.extname(file.originalname).toLowerCase() || ".pdf";
    callback(null, `doc-${Date.now()}-${uniqueSuffix}${extension}`);
  },
});

export const uploadBudgetAllocationDocument = multer({
  storage: budgetAllocationDocumentStorage,
  limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_DOCUMENT_MIME_TYPES.has(file.mimetype) && !ALLOWED_DOCUMENT_EXTENSIONS.has(extension)) {
      callback(new Error("Only PDF, DOC, or DOCX files are allowed."));
      return;
    }
    callback(null, true);
  },
}).single("document");

/**
 * Disk storage for Expenditure bill/voucher reference documents (same file
 * type/size constraints as Budget Setup/Allocation's documents, kept in its
 * own directory so the modules' uploads never collide by filename).
 */
const EXPENDITURE_DOCUMENTS_DIR = path.join(UPLOAD_ROOT_DIR, "expenditures");
fs.mkdirSync(EXPENDITURE_DOCUMENTS_DIR, { recursive: true });

const expenditureDocumentStorage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, EXPENDITURE_DOCUMENTS_DIR);
  },
  filename: (_req, file, callback) => {
    const uniqueSuffix = crypto.randomBytes(8).toString("hex");
    const extension = path.extname(file.originalname).toLowerCase() || ".pdf";
    callback(null, `doc-${Date.now()}-${uniqueSuffix}${extension}`);
  },
});

export const uploadExpenditureDocument = multer({
  storage: expenditureDocumentStorage,
  limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_DOCUMENT_MIME_TYPES.has(file.mimetype) && !ALLOWED_DOCUMENT_EXTENSIONS.has(extension)) {
      callback(new Error("Only PDF, DOC, or DOCX files are allowed."));
      return;
    }
    callback(null, true);
  },
}).single("document");

/**
 * Disk storage for Payroll batch supporting documents (sanction letters,
 * payroll sheets, etc.) — same constraints as Expenditure's documents, own
 * directory so uploads never collide by filename.
 */
const PAYROLL_DOCUMENTS_DIR = path.join(UPLOAD_ROOT_DIR, "payroll-batches");
fs.mkdirSync(PAYROLL_DOCUMENTS_DIR, { recursive: true });

const payrollDocumentStorage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, PAYROLL_DOCUMENTS_DIR);
  },
  filename: (_req, file, callback) => {
    const uniqueSuffix = crypto.randomBytes(8).toString("hex");
    const extension = path.extname(file.originalname).toLowerCase() || ".pdf";
    callback(null, `doc-${Date.now()}-${uniqueSuffix}${extension}`);
  },
});

export const uploadPayrollDocument = multer({
  storage: payrollDocumentStorage,
  limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_DOCUMENT_MIME_TYPES.has(file.mimetype) && !ALLOWED_DOCUMENT_EXTENSIONS.has(extension)) {
      callback(new Error("Only PDF, DOC, or DOCX files are allowed."));
      return;
    }
    callback(null, true);
  },
}).single("document");

/**
 * Disk storage for a user's own profile photo — same pattern as the
 * branding logo, own directory, no SVG (a profile photo is a raster image,
 * never a vector).
 */
const PROFILE_PHOTOS_DIR = path.join(UPLOAD_ROOT_DIR, "profile-photos");
fs.mkdirSync(PROFILE_PHOTOS_DIR, { recursive: true });

const ALLOWED_PROFILE_PHOTO_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_PROFILE_PHOTO_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

const profilePhotoStorage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, PROFILE_PHOTOS_DIR);
  },
  filename: (_req, file, callback) => {
    const uniqueSuffix = crypto.randomBytes(8).toString("hex");
    const extension = path.extname(file.originalname).toLowerCase() || ".png";
    callback(null, `profile-${Date.now()}-${uniqueSuffix}${extension}`);
  },
});

export const uploadProfilePhoto = multer({
  storage: profilePhotoStorage,
  limits: { fileSize: MAX_PROFILE_PHOTO_SIZE_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_PROFILE_PHOTO_MIME_TYPES.has(file.mimetype)) {
      callback(new Error("Only PNG, JPEG, or WEBP photos are allowed."));
      return;
    }
    callback(null, true);
  },
}).single("photo");

export function profilePhotoPath(storedFileName: string): string {
  return path.join(PROFILE_PHOTOS_DIR, storedFileName);
}

/**
 * multer's fileFilter only sees the client-reported mimetype before the
 * file is written — every other upload in this app stops there, but a
 * profile photo is public-facing (rendered in the header for everyone who
 * can see this user), so it gets one extra check nothing else here has: the
 * real magic bytes of the file actually written to disk, to catch a
 * renamed/relabeled non-image slipping past the mimetype check.
 */
export async function isValidImageSignature(filePath: string, mimetype: string): Promise<boolean> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, 12, 0);
    if (bytesRead < 4) return false;

    if (mimetype === "image/png") {
      return buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
    if (mimetype === "image/jpeg") {
      return buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    }
    if (mimetype === "image/webp") {
      return (
        bytesRead >= 12 &&
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP"
      );
    }
    return false;
  } finally {
    await handle.close();
  }
}
