/**
 * Accept a verified HTTPS delivery URL while refusing provenance hosts. The
 * database keeps the official Riksdagen URL for audit, but it must never become
 * a browser fallback when Pleni's mirror is missing.
 */
export function normalizePartyLogoUrl(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) {
    return null;
  }
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hostname === "riksdagen.se" ||
      parsed.hostname.endsWith(".riksdagen.se")
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}
