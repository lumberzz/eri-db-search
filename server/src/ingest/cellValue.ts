export function cellToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.text === "string") return v.text;
    if (Array.isArray(v.richText)) {
      return v.richText
        .map((p: { text?: string }) => (typeof p.text === "string" ? p.text : ""))
        .join("");
    }
    if (v.result != null) return cellToString(v.result);
    if (v.hyperlink != null && typeof v.text === "string") return v.text;
  }
  return String(value);
}
