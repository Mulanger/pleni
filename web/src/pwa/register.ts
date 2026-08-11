export const PWA_UPDATE_AVAILABLE_EVENT = "pleni:pwa-update-available";
export const PWA_CONTROLLER_CHANGED_EVENT = "pleni:pwa-controller-changed";

const ACTIVATE_UPDATE_MESSAGE = "SKIP_WAITING";

let currentRegistration: ServiceWorkerRegistration | null = null;
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

function notifyUpdateAvailable(): void {
  window.dispatchEvent(new Event(PWA_UPDATE_AVAILABLE_EVENT));
}

function watchRegistration(registration: ServiceWorkerRegistration): void {
  if (registration.waiting) {
    notifyUpdateAvailable();
  }

  registration.addEventListener("updatefound", () => {
    const installingWorker = registration.installing;
    if (!installingWorker) {
      return;
    }

    installingWorker.addEventListener("statechange", () => {
      if (
        installingWorker.state === "installed" &&
        navigator.serviceWorker.controller !== null
      ) {
        notifyUpdateAvailable();
      }
    });
  });
}

async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  try {
    const baseUrl = import.meta.env.BASE_URL;
    const serviceWorkerUrl = new URL(`${baseUrl}sw.js`, window.location.origin);
    const registration = await navigator.serviceWorker.register(serviceWorkerUrl, {
      scope: baseUrl
    });
    currentRegistration = registration;
    watchRegistration(registration);
    return registration;
  } catch (error: unknown) {
    console.warn("Pleni could not register its offline app shell.", error);
    return null;
  }
}

function startRegistration(): void {
  registrationPromise ??= registerWorker();
}

export function registerPwa(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return;
  }

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    window.dispatchEvent(new Event(PWA_CONTROLLER_CHANGED_EVENT));
  });

  if (document.readyState === "complete") {
    startRegistration();
    return;
  }

  window.addEventListener("load", startRegistration, { once: true });
}

export function getPwaRegistration(): ServiceWorkerRegistration | null {
  return currentRegistration;
}

export function getWaitingServiceWorker(): ServiceWorker | null {
  return currentRegistration?.waiting ?? null;
}

export function activateWaitingServiceWorker(): boolean {
  const waitingWorker = getWaitingServiceWorker();
  if (!waitingWorker) {
    return false;
  }

  waitingWorker.postMessage({ type: ACTIVATE_UPDATE_MESSAGE });
  return true;
}
