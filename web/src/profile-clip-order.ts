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

/** Append one cursor page without duplicating a row if the catalogue changed mid-session. */
export function appendUniqueProfileClips<T extends { id: string }>(
  current: readonly T[],
  nextPage: readonly T[]
): T[] {
  const seen = new Set(current.map((clip) => clip.id));
  return [
    ...current,
    ...nextPage.filter((clip) => {
      if (seen.has(clip.id)) {
        return false;
      }
      seen.add(clip.id);
      return true;
    })
  ];
}
