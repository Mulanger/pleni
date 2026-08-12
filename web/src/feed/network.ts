import { useEffect, useState } from "react";
import { allowsSecondLookahead } from "./media-policy";
import type { MediaConnectionHint } from "./media-policy";

interface ObservableMediaConnectionHint extends MediaConnectionHint {
  addEventListener?: (type: "change", listener: EventListener) => void;
  removeEventListener?: (type: "change", listener: EventListener) => void;
}

type NavigatorWithConnection = Navigator & {
  connection?: ObservableMediaConnectionHint;
};

function currentConnection(): ObservableMediaConnectionHint | null {
  return (navigator as NavigatorWithConnection).connection ?? null;
}

/** Re-evaluate the bounded look-ahead when Data Saver/network hints change. */
export function useSecondLookahead(): boolean {
  const [allowed, setAllowed] = useState(() =>
    allowsSecondLookahead(currentConnection())
  );

  useEffect(() => {
    const connection = currentConnection();
    if (!connection) {
      return;
    }

    const update = () => setAllowed(allowsSecondLookahead(connection));
    const listener: EventListener = update;
    connection.addEventListener?.("change", listener);
    update();
    return () => connection.removeEventListener?.("change", listener);
  }, []);

  return allowed;
}
