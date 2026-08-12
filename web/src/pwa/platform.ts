type IosStandaloneNavigator = Navigator & { standalone?: boolean };

export type InstallChoice = {
  outcome: "accepted" | "dismissed";
  platform?: string;
};

export type DeferredInstallPromptEvent = Event & {
  prompt: () => Promise<InstallChoice | void>;
  userChoice: Promise<InstallChoice>;
};

export function isStandaloneDisplayMode(): boolean {
  const iosStandalone = (navigator as IosStandaloneNavigator).standalone === true;
  return window.matchMedia("(display-mode: standalone)").matches || iosStandalone;
}

export function isAppleMobileSafari(): boolean {
  const appleMobileUserAgent = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const touchEnabledIpad =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const competingIosBrowser = /CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);
  return (
    (appleMobileUserAgent || touchEnabledIpad) &&
    /Safari/.test(navigator.userAgent) &&
    !competingIosBrowser
  );
}

export function pauseAllVideoPlayback(): void {
  document.querySelectorAll<HTMLVideoElement>("video").forEach((video) => video.pause());
}

export function hasUnsafeUpdateActivity(): boolean {
  const playingVideo = [...document.querySelectorAll("video")].some(
    (video) => !video.paused && !video.ended
  );
  const commentDraft = [
    ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      ".comment-composer input, .comment-composer textarea"
    )
  ].some((field) => field.value.trim().length > 0);
  return playingVideo || commentDraft;
}
