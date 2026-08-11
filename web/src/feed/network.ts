import { useEffect, useState } from "react";

export type NeighborVideoPreload = "auto" | "metadata";

export interface MediaConnectionHint {
  saveData?: boolean;
  effectiveType?: string;
  addEventListener?: (type: "change", listener: EventListener) => void;
  removeEventListener?: (type: "change", listener: EventListener) => void;
}

type NavigatorWithConnection = Navigator & {
  connection?: MediaConnectionHint;
};

/**
 * Only a connection that explicitly reports both normal data use and at least
 * 3G earns eager loading for one predicted neighbor. Missing information is a
 * bandwidth constraint, not permission to assume an unlimited connection.
 */
export function neighborVideoPreload(
  connection: MediaConnectionHint | null | undefined
): NeighborVideoPreload {
  if (connection?.saveData !== false) {
    return "metadata";
  }

  const effectiveType = connection.effectiveType?.toLowerCase();
  return effectiveType === "3g" || effectiveType === "4g" ? "auto" : "metadata";
}

function currentConnection(): MediaConnectionHint | null {
  return (navigator as NavigatorWithConnection).connection ?? null;
}

/** Safari and other unsupported browsers stay on the conservative default. */
export function useNeighborVideoPreload(): NeighborVideoPreload {
  const [preload, setPreload] = useState<NeighborVideoPreload>(() =>
    neighborVideoPreload(currentConnection())
  );

  useEffect(() => {
    const connection = currentConnection();
    if (!connection) {
      return;
    }

    const update = () => setPreload(neighborVideoPreload(connection));
    const listener: EventListener = update;
    connection.addEventListener?.("change", listener);
    update();
    return () => connection.removeEventListener?.("change", listener);
  }, []);

  return preload;
}
