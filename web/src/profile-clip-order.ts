export interface DatedProfileClip {
  id: string;
  debateDate: string;
  publishedAt: string | null;
}

/** Newest parliamentary speech first; upload time only breaks same-date ties. */
export function newestProfileClipsFirst<T extends DatedProfileClip>(clips: readonly T[]): T[] {
  return [...clips].sort(
    (left, right) =>
      right.debateDate.localeCompare(left.debateDate) ||
      (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "") ||
      left.id.localeCompare(right.id)
  );
}
