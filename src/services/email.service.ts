import nodemailer, { Transporter } from "nodemailer";
import { env } from "../config/env";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.smtpConfigured) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  });

  return transporter;
}

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

/** Falls back to a console log when SMTP isn't configured, so auth flows keep working in dev. */
async function sendEmail(options: SendEmailOptions): Promise<void> {
  const client = getTransporter();

  if (!client) {
    console.log(
      `[email] SMTP not configured — logging instead of sending.\n  To: ${options.to}\n  Subject: ${options.subject}\n  Body: ${options.html}`
    );
    return;
  }

  await client.sendMail({
    from: env.SMTP_FROM,
    to: options.to,
    subject: options.subject,
    html: options.html,
  });
}

export async function sendWelcomeEmail(to: string, fullname: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Welcome to Alight FMS",
    html: `<p>Hi ${fullname},</p><p>Your account has been created successfully.</p>`,
  });
}

export async function sendPasswordResetEmail(
  to: string,
  fullname: string,
  resetUrl: string
): Promise<void> {
  await sendEmail({
    to,
    subject: "Reset your password",
    html: `<p>Hi ${fullname},</p><p>We received a request to reset your password. This link expires in 1 hour.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you did not request this, you can safely ignore this email.</p>`,
  });
}

export async function sendPasswordResetConfirmationEmail(
  to: string,
  fullname: string
): Promise<void> {
  await sendEmail({
    to,
    subject: "Your password has been reset",
    html: `<p>Hi ${fullname},</p><p>Your password was successfully reset. If this wasn't you, contact support immediately.</p>`,
  });
}

export async function sendPasswordChangedEmail(to: string, fullname: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Your password was changed",
    html: `<p>Hi ${fullname},</p><p>Your password was just changed. If this wasn't you, contact support immediately.</p>`,
  });
}
