/** Display authored values without silently rounding a small input to zero. */
export function formatIntelligentValue(value: string | number | boolean | null, decimals?: number): string {
  if (value === null || typeof value === "number" && !Number.isFinite(value)) return "Unavailable";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (Object.is(value, -0)) return "0";
  const options: Intl.NumberFormatOptions = decimals === undefined
    ? { maximumSignificantDigits: 21 }
    : { maximumFractionDigits: decimals };
  const formatted = value.toLocaleString(undefined, options);
  // Explicit precision applies to normal metrics, but must not hide nonzero values.
  if (value !== 0 && Math.abs(value) < 1e-6 || decimals !== undefined && value !== 0 && Math.abs(value) < 0.5 * 10 ** -decimals) {
    return value.toLocaleString(undefined, { notation: "scientific", maximumSignificantDigits: 21 });
  }
  return formatted;
}

/** Numeric columns sort numerically; missing values stay last in either direction. */
export function compareIntelligentValues(a: string | number | boolean | null, b: string | number | boolean | null, direction: "asc" | "desc"): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  const order = typeof a === "number" && typeof b === "number" ? a - b
    : typeof a === "boolean" && typeof b === "boolean" ? Number(a) - Number(b)
    : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  return direction === "asc" ? order : -order;
}
