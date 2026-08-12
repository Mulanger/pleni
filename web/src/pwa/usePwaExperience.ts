import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PWA_CONTROLLER_CHANGED_EVENT,
  PWA_UPDATE_AVAILABLE_EVENT,
  activateWaitingServiceWorker,
  getWaitingServiceWorker
} from "./register";
import {
  hasUnsafeUpdateActivity,
  isAppleMobileSafari,
  isStandaloneDisplayMode,
  pauseAllVideoPlayback
} from "./platform";
import type { DeferredInstallPromptEvent, InstallChoice } from "./platform";

export type PwaInstallKind = "chromium" | "ios" | "manual";
export type PwaUpdatePhase =
  | "hidden"
  | "available"
  | "deferred"
  | "preparing"
  | "activating"
  | "completed";

const UPDATE_COMPLETED_SESSION_KEY = "riket.pwa.update-completed.v1";
const UPDATE_COMPLETED_NOTICE_MS = 5000;
const UPDATE_VISUAL_DELAY_MS = 2000;

function rememberCompletedUpdate(): void {
  try {
    window.sessionStorage.setItem(UPDATE_COMPLETED_SESSION_KEY, "1");
  } catch {
    // A storage-denied browser may skip confirmation, but must still update.
  }
}

function takeCompletedUpdate(): boolean {
  try {
    const completed = window.sessionStorage.getItem(UPDATE_COMPLETED_SESSION_KEY) === "1";
    window.sessionStorage.removeItem(UPDATE_COMPLETED_SESSION_KEY);
    return completed;
  } catch {
    return false;
  }
}

export type PwaExperience = {
  standalone: boolean;
  installKind: PwaInstallKind | null;
  installBusy: boolean;
  showInstallInstructions: boolean;
  requestInstall: () => Promise<void>;
  dismissInstallInstructions: () => void;
  offlineMessage: string | null;
  dismissOffline: () => void;
  updatePhase: PwaUpdatePhase;
  requestUpdate: () => void;
  dismissUpdate: () => void;
};

function installChoiceFrom(
  promptResult: InstallChoice | void,
  event: DeferredInstallPromptEvent
): Promise<InstallChoice> {
  return promptResult ? Promise.resolve(promptResult) : event.userChoice;
}

export function usePwaExperience(networkRequestFailed: boolean): PwaExperience {
  const [standalone, setStandalone] = useState(isStandaloneDisplayMode);
  const [installPromptAvailable, setInstallPromptAvailable] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [showInstallInstructions, setShowInstallInstructions] = useState(false);
  const deferredInstallPrompt = useRef<DeferredInstallPromptEvent | null>(null);

  const [browserOnline, setBrowserOnline] = useState(navigator.onLine);
  const [offlineDismissed, setOfflineDismissed] = useState(false);
  const previousOfflineReason = useRef<string | null>(null);

  const [updatePhase, setUpdatePhase] = useState<PwaUpdatePhase>(() =>
    getWaitingServiceWorker() ? "available" : "hidden"
  );
  const updateDismissed = useRef(false);
  const activationRequested = useRef(false);
  const activationSent = useRef(false);
  const controllerReady = useRef(false);
  const reloadStarted = useRef(false);
  const visualDelayStarted = useRef(false);
  const visualDelayTimer = useRef<number | null>(null);

  useEffect(() => {
    const displayMode = window.matchMedia("(display-mode: standalone)");
    const updateStandalone = () => setStandalone(isStandaloneDisplayMode());
    displayMode.addEventListener("change", updateStandalone);
    return () => displayMode.removeEventListener("change", updateStandalone);
  }, []);

  useEffect(() => {
    const captureInstallPrompt = (event: Event) => {
      const promptEvent = event as DeferredInstallPromptEvent;
      promptEvent.preventDefault();
      deferredInstallPrompt.current = promptEvent;
      setInstallPromptAvailable(true);
      setShowInstallInstructions(false);
    };
    const markInstalled = () => {
      deferredInstallPrompt.current = null;
      setInstallPromptAvailable(false);
      setShowInstallInstructions(false);
    };
    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    window.addEventListener("appinstalled", markInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", captureInstallPrompt);
      window.removeEventListener("appinstalled", markInstalled);
    };
  }, []);

  useEffect(() => {
    const markOnline = () => setBrowserOnline(true);
    const markOffline = () => setBrowserOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  const offlineReason = !browserOnline
    ? "offline"
    : networkRequestFailed
      ? "network-failure"
      : null;

  useEffect(() => {
    if (offlineReason !== previousOfflineReason.current) {
      previousOfflineReason.current = offlineReason;
      setOfflineDismissed(false);
    }
  }, [offlineReason]);

  const sendActivation = useCallback(() => {
    if (activationSent.current) {
      return;
    }
    activationSent.current = true;
    setUpdatePhase("activating");
    if (!activateWaitingServiceWorker()) {
      activationSent.current = false;
      activationRequested.current = false;
      visualDelayStarted.current = false;
      setUpdatePhase("hidden");
    }
  }, []);

  const beginVisualUpdate = useCallback(() => {
    if (visualDelayStarted.current || activationSent.current) {
      return;
    }

    visualDelayStarted.current = true;
    pauseAllVideoPlayback();
    setUpdatePhase("preparing");
    visualDelayTimer.current = window.setTimeout(() => {
      visualDelayTimer.current = null;
      sendActivation();
    }, UPDATE_VISUAL_DELAY_MS);
  }, [sendActivation]);

  useEffect(
    () => () => {
      if (visualDelayTimer.current !== null) {
        window.clearTimeout(visualDelayTimer.current);
      }
    },
    []
  );

  const reloadWhenSafe = useCallback(() => {
    if (reloadStarted.current || hasUnsafeUpdateActivity()) {
      setUpdatePhase("deferred");
      return;
    }
    reloadStarted.current = true;
    rememberCompletedUpdate();
    window.location.reload();
  }, []);

  useEffect(() => {
    if (!takeCompletedUpdate()) {
      return;
    }

    setUpdatePhase("completed");
    const timer = window.setTimeout(() => {
      setUpdatePhase((current) => (current === "completed" ? "hidden" : current));
    }, UPDATE_COMPLETED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const showUpdate = () => {
      if (!updateDismissed.current) {
        setUpdatePhase("available");
      }
    };
    const handleControllerChange = () => {
      if (!activationRequested.current) {
        return;
      }
      controllerReady.current = true;
      reloadWhenSafe();
    };
    window.addEventListener(PWA_UPDATE_AVAILABLE_EVENT, showUpdate);
    window.addEventListener(PWA_CONTROLLER_CHANGED_EVENT, handleControllerChange);
    if (getWaitingServiceWorker()) {
      showUpdate();
    }
    return () => {
      window.removeEventListener(PWA_UPDATE_AVAILABLE_EVENT, showUpdate);
      window.removeEventListener(PWA_CONTROLLER_CHANGED_EVENT, handleControllerChange);
    };
  }, [reloadWhenSafe]);

  useEffect(() => {
    if (updatePhase !== "deferred") {
      return;
    }

    const continueWhenSafe = () => {
      if (hasUnsafeUpdateActivity()) {
        return;
      }
      if (controllerReady.current) {
        reloadWhenSafe();
        return;
      }
      beginVisualUpdate();
    };
    const timer = window.setInterval(continueWhenSafe, 400);
    document.addEventListener("pause", continueWhenSafe, true);
    document.addEventListener("input", continueWhenSafe, true);
    window.addEventListener("hashchange", continueWhenSafe);
    continueWhenSafe();
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("pause", continueWhenSafe, true);
      document.removeEventListener("input", continueWhenSafe, true);
      window.removeEventListener("hashchange", continueWhenSafe);
    };
  }, [beginVisualUpdate, reloadWhenSafe, updatePhase]);

  const installKind = useMemo<PwaInstallKind | null>(() => {
    if (standalone) {
      return null;
    }
    if (installPromptAvailable) {
      return "chromium";
    }
    return window.isSecureContext && isAppleMobileSafari() ? "ios" : "manual";
  }, [installPromptAvailable, standalone]);

  const requestInstall = useCallback(async () => {
    if (installKind === "ios" || installKind === "manual") {
      setShowInstallInstructions(true);
      return;
    }

    const promptEvent = deferredInstallPrompt.current;
    if (installKind !== "chromium" || !promptEvent) {
      return;
    }

    setInstallBusy(true);
    try {
      await installChoiceFrom(await promptEvent.prompt(), promptEvent);
    } catch (error: unknown) {
      console.warn("Pleni could not show the browser install prompt.", error);
    } finally {
      deferredInstallPrompt.current = null;
      setInstallPromptAvailable(false);
      setInstallBusy(false);
    }
  }, [installKind]);

  const offlineMessage = offlineDismissed
    ? null
    : offlineReason === "offline"
      ? "Pleni är offline. Appen öppnas, men nytt innehåll kräver nätverk."
      : offlineReason === "network-failure"
        ? "Pleni fick inget svar från nätverket. Försök igen när anslutningen är tillbaka."
        : null;

  return {
    standalone,
    installKind,
    installBusy,
    showInstallInstructions,
    requestInstall,
    dismissInstallInstructions: () => setShowInstallInstructions(false),
    offlineMessage,
    dismissOffline: () => setOfflineDismissed(true),
    updatePhase,
    requestUpdate: () => {
      activationRequested.current = true;
      pauseAllVideoPlayback();
      if (hasUnsafeUpdateActivity()) {
        setUpdatePhase("deferred");
        return;
      }
      beginVisualUpdate();
    },
    dismissUpdate: () => {
      updateDismissed.current = true;
      setUpdatePhase("hidden");
    }
  };
}
