export interface PartyMemberName {
  name: string;
}

/** Normalize Swedish names so "a" also finds "Å" and spacing never matters. */
export function normalizePartyMemberQuery(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("sv-SE")
    .trim()
    .replace(/\s+/g, " ");
}

/** Match every entered word against one politician name, preserving server order. */
export function filterPartyMembers<T extends PartyMemberName>(
  members: readonly T[],
  query: string
): T[] {
  const terms = normalizePartyMemberQuery(query).split(" ").filter(Boolean);
  if (terms.length === 0) {
    return [...members];
  }
  return members.filter((member) => {
    const name = normalizePartyMemberQuery(member.name);
    return terms.every((term) => name.includes(term));
  });
}
