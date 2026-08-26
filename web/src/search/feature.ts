/**
 * Normal production remains dark. The signed-in owner Android beta can opt in
 * with a non-persistent URL marker; an explicit false is always the kill switch.
 */
export function topicSearchEnabledFrom(
  value: string | undefined,
  ownerBetaRequested = false,
): boolean {
  if (value === undefined || value.trim() === "") {
    return ownerBetaRequested;
  }
  return value.trim().toLowerCase() === "true";
}

const ownerBetaRequested =
  import.meta.env?.PROD === true &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("topic-search-beta") === "android";

export const topicSearchEnabled = topicSearchEnabledFrom(
  import.meta.env?.VITE_TOPIC_SEARCH_ENABLED,
  ownerBetaRequested,
);
