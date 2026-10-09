import PDFDocument from "pdfkit";
import type { Response } from "express";

export interface PdfReportColumn {
  key: string;
  label: string;
  format?: (value: unknown) => string;
}

export interface PdfReportKpiTile {
  label: string;
  value: string;
}

export interface PdfReportOptions {
  title: string;
  subtitle?: string;
  kpiTiles?: PdfReportKpiTile[];
  columns: PdfReportColumn[];
  rows: unknown[];
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/**
 * The only PDF-rendering path in this codebase — a simple, clean title +
 * optional KPI-tile row + bordered table, repeating the header on page
 * overflow. Scoped to the small, row-bounded "summary" reports (Budget
 * Summary, Budget Availability, Organization Node Financial, Financial
 * Year Summary) — raw transaction lists stay CSV-only, the same convention
 * every other export in this app already uses.
 */
export function streamPdfReport(res: Response, options: PdfReportOptions): void {
  const landscape = options.columns.length > 6;
  const doc = new PDFDocument({ margin: 40, size: "A4", layout: landscape ? "landscape" : "portrait" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${slugify(options.title)}-${new Date().toISOString().slice(0, 10)}.pdf"`);
  doc.pipe(res);

  const left = doc.page.margins.left;
  const pageWidth = doc.page.width - left - doc.page.margins.right;

  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111827").text(options.title);
  if (options.subtitle) {
    doc.font("Helvetica").fontSize(10).fillColor("#6B7280").text(options.subtitle);
  }
  doc.font("Helvetica").fontSize(8).fillColor("#9CA3AF").text(`Generated ${new Date().toLocaleString("en-IN")}`);
  doc.fillColor("#111827");
  doc.moveDown(1);

  if (options.kpiTiles && options.kpiTiles.length > 0) {
    const tileWidth = pageWidth / options.kpiTiles.length;
    const startY = doc.y;
    options.kpiTiles.forEach((tile, i) => {
      const x = left + i * tileWidth;
      doc.font("Helvetica").fontSize(8).fillColor("#6B7280").text(tile.label, x, startY, { width: tileWidth - 10 });
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827").text(tile.value, x, startY + 12, { width: tileWidth - 10 });
    });
    doc.y = startY + 42;
    doc.moveDown(0.5);
  }

  const columns = options.columns;
  const colWidth = pageWidth / columns.length;
  const rowHeight = 18;

  function drawTableHeader(y: number): number {
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827");
    columns.forEach((col, i) => {
      doc.text(col.label, left + i * colWidth, y, { width: colWidth - 6 });
    });
    const lineY = y + 14;
    doc
      .moveTo(left, lineY)
      .lineTo(left + pageWidth, lineY)
      .strokeColor("#D1D5DB")
      .lineWidth(1)
      .stroke();
    doc.font("Helvetica").fontSize(8).fillColor("#111827");
    return lineY + 6;
  }

  let y = drawTableHeader(doc.y);
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  for (const row of options.rows) {
    if (y + rowHeight > bottomLimit) {
      doc.addPage();
      y = drawTableHeader(doc.page.margins.top);
    }
    const record = row as Record<string, unknown>;
    columns.forEach((col, i) => {
      const raw = record[col.key];
      const text = col.format ? col.format(raw) : raw === null || raw === undefined ? "" : String(raw);
      doc.text(text, left + i * colWidth, y, { width: colWidth - 6 });
    });
    y += rowHeight;
  }

  if (options.rows.length === 0) {
    doc.font("Helvetica").fontSize(9).fillColor("#6B7280").text("No data for the selected filters.", left, y);
  }

  doc.end();
}
