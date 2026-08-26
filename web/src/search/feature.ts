/**
 * Topic search is part of the normal production Search tab. An explicit false
 * remains the emergency kill switch; non-production builds stay opt-in.
 */
export function topicSearchEnabledFrom(
  value: string | undefined,
  defaultEnabled = false,
): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultEnabled;
  }
  return value.trim().toLowerCase() === "true";
}

export const topicSearchEnabled = topicSearchEnabledFrom(
  import.meta.env?.VITE_TOPIC_SEARCH_ENABLED,
  import.meta.env?.PROD === true,
);
