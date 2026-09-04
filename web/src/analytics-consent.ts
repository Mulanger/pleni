export const ANALYTICS_CONSENT_VERSION = "2026-09-04";
export const ANALYTICS_CONSENT_STORAGE_KEY = "pleni.analytics-consent.v1";

export type AnalyticsConsentChoice = "granted" | "denied";

export interface AnalyticsConsentRecord {
  version: typeof ANALYTICS_CONSENT_VERSION;
  analytics: AnalyticsConsentChoice;
  decidedAt: string;
}

function isChoice(value: unknown): value is AnalyticsConsentChoice {
  return value === "granted" || value === "denied";
}

export function readAnalyticsConsent(): AnalyticsConsentRecord | null {
  try {
    const raw = window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AnalyticsConsentRecord>;
    if (
      value.version !== ANALYTICS_CONSENT_VERSION ||
      !isChoice(value.analytics) ||
      typeof value.decidedAt !== "string"
    ) {
      return null;
    }
    return value as AnalyticsConsentRecord;
  } catch {
    return null;
  }
}

export function writeAnalyticsConsent(
  analytics: AnalyticsConsentChoice
): AnalyticsConsentRecord {
  const record: AnalyticsConsentRecord = {
    version: ANALYTICS_CONSENT_VERSION,
    analytics,
    decidedAt: new Date().toISOString()
  };
  try {
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Private browsing/storage restrictions must not make the public feed fail.
  }
  return record;
}
