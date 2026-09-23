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
