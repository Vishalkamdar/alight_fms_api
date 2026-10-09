/**
 * Plain-text Indian-grouped currency for PDF rendering — PDFKit's default
 * built-in fonts don't reliably carry the ₹ glyph, so PDFs use "Rs." while
 * CSV/JSON responses elsewhere in the app keep the real `formatCurrency`
 * (with ₹) on the frontend.
 */
export function formatCurrencyPlain(value: number): string {
  const rounded = Math.round(value);
  const formatted = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.abs(rounded));
  return `${rounded < 0 ? "-" : ""}Rs. ${formatted}`;
}
