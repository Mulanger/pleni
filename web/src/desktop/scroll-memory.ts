export type ScrollMemory = {
  read: (key: string) => number;
  write: (key: string, position: number) => void;
};

/** Session-only route scroll memory; it never persists browsing behavior. */
export function createScrollMemory(): ScrollMemory {
  const positions = new Map<string, number>();
  return {
    read: (key) => positions.get(key) ?? 0,
    write: (key, position) => {
      positions.set(key, Math.max(0, Number.isFinite(position) ? position : 0));
    }
  };
}
