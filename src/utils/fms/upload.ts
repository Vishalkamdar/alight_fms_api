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
