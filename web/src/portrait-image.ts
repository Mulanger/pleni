export const MAX_PORTRAIT_RETRIES = 2;

export interface PortraitDeliveryState {
  displayUrl: string;
  attempt: number;
  retryToken: number;
  loaded: boolean;
  failed: boolean;
}

export interface CompleteImageState {
  complete: boolean;
  naturalWidth: number;
}

/*
 * Portraits use immutable, content-addressed Bunny URLs. Remembering the exact
 * URL that painted successfully for the lifetime of this page is therefore
 * safe and lets a new Avatar instance reuse that success after tab navigation.
 * This intentionally stays in memory rather than persisting viewing activity.
 */
const successfulPortraitUrls = new Map<string, string>();

function retryTokenFromUrl(url: string): number {
  try {
    const rawAttempt = new URL(url).searchParams.get("pleni_retry");
    const attempt = rawAttempt === null ? 0 : Number.parseInt(rawAttempt, 10);
    return Number.isInteger(attempt) && attempt >= 0 ? attempt : 0;
  } catch {
    return 0;
  }
}

export function portraitRetryUrl(sourceUrl: string, attempt: number): string {
  if (attempt <= 0) {
    return sourceUrl;
  }
  try {
    const retryUrl = new URL(sourceUrl);
    retryUrl.searchParams.set("pleni_retry", String(attempt));
    return retryUrl.toString();
  } catch {
    return sourceUrl;
  }
}

export function rememberPortraitSuccess(sourceUrl: string, displayUrl: string): void {
  successfulPortraitUrls.set(sourceUrl, displayUrl);
}

export function forgetPortraitSuccess(sourceUrl: string, failedDisplayUrl: string): void {
  if (successfulPortraitUrls.get(sourceUrl) === failedDisplayUrl) {
    successfulPortraitUrls.delete(sourceUrl);
  }
}

export function createPortraitDelivery(sourceUrl: string): PortraitDeliveryState {
  const successfulUrl = successfulPortraitUrls.get(sourceUrl);
  return {
    displayUrl: successfulUrl ?? sourceUrl,
    // A previous lifecycle's recovery URL may be reused, but its failures do
    // not consume this lifecycle's bounded retry allowance.
    attempt: 0,
    retryToken: retryTokenFromUrl(successfulUrl ?? sourceUrl),
    loaded: successfulUrl !== undefined,
    failed: false
  };
}

export function retryPortraitDelivery(
  sourceUrl: string,
  current: PortraitDeliveryState
): PortraitDeliveryState {
  if (current.attempt >= MAX_PORTRAIT_RETRIES) {
    return { ...current, loaded: false, failed: true };
  }
  const attempt = current.attempt + 1;
  const retryToken = current.retryToken + 1;
  return {
    displayUrl: portraitRetryUrl(sourceUrl, retryToken),
    attempt,
    retryToken,
    loaded: false,
    failed: false
  };
}

export function isCompletePortraitImage(image: CompleteImageState): boolean {
  return image.complete && image.naturalWidth > 0;
}
