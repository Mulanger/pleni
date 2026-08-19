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

interface CompletePartyLogoImage {
  complete: boolean;
  naturalWidth: number;
}

/*
 * Party logos are immutable, content-addressed CDN objects. Remembering a URL
 * that decoded successfully for this page lifetime lets the same mark move
 * between search, following and profile surfaces without replaying its loading
 * state after each component remount.
 */
const successfulPartyLogoUrls = new Set<string>();

export function rememberPartyLogoSuccess(url: string): void {
  successfulPartyLogoUrls.add(url);
}

export function forgetPartyLogoSuccess(url: string): void {
  successfulPartyLogoUrls.delete(url);
}

export function hasPartyLogoSuccess(url: string): boolean {
  return successfulPartyLogoUrls.has(url);
}

export function isCompletePartyLogoImage(image: CompletePartyLogoImage): boolean {
  return image.complete && image.naturalWidth > 0;
}

export function shouldShowPartyLogoFallback(
  displayUrl: string | null,
  failedUrl: string | null
): boolean {
  return displayUrl === null || failedUrl === displayUrl;
}
