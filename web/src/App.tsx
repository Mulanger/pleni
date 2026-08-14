import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowUpRight,
  Bookmark,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Flag,
  Heart,
  Home,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Search,
  Send,
  Share2,
  Sliders,
  Trash2,
  UserPlus,
  UserRound,
  Users,
  Volume2,
  VolumeX,
  WifiOff,
  X
} from "lucide-react";
import {
  Show,
  SignInButton,
  SignOutButton,
  SignUpButton,
  UserButton,
  useUser
} from "@clerk/react";
import {
  RecommendationApiError,
  deleteRecommendationData,
  exportRecommendationData,
  loadRecommendationProfile,
  loadRuleBasedFeed,
  recommendationsEnabled,
  resetRecommendationData,
  setRecommendationConsent,
  syncRecommendationPreferences
} from "./account";
import { clerkEnabled, useViewer } from "./clerk";
import {
  COMMENT_MAX_LENGTH,
  COMMENT_USERNAME_PATTERN,
  commentErrorMessage,
  createVideoComment,
  deleteVideoComment,
  loadMyCommentUsername,
  loadVideoComments,
  normalizeCommentUsername,
  reportVideoComment
} from "./comments";
import type { CommentReportReason, CommentThread, VideoComment } from "./comments";
import { initials, PARTIES, partyInk, partyTint, TRENDING } from "./data";
import { EMPTY_RECOMMENDATION_PROFILE, PERSONALIZATION_NOTICE_VERSION } from "./consent";
import {
  attachMediaSource,
  planMediaWindow,
  releaseMediaSource
} from "./feed/media-policy";
import { useSecondLookahead } from "./feed/network";
import { Onboarding } from "./onboarding";
import { EMPTY_ONBOARDING, readOnboarding, writeOnboarding } from "./onboarding-store";
import { EMPTY_LIBRARY, readLibrary, toggleInList, writeLibrary } from "./library-store";
import { LEGAL_PAGE_ORDER, LEGAL_PAGES, LEGAL_VERSION } from "./legal";
import type { LegalPageId } from "./legal";
import { useAppNavigation } from "./navigation";
import {
  createPortraitDelivery,
  forgetPortraitSuccess,
  isCompletePortraitImage,
  rememberPortraitSuccess,
  retryPortraitDelivery
} from "./portrait-image";
import { applyBrowserTheme } from "./pwa/theme";
import { usePwaExperience } from "./pwa/usePwaExperience";
import type { PwaExperience } from "./pwa/usePwaExperience";
import {
  loadClipsByIds,
  loadClipsForParty,
  loadClipsForPolitician,
  loadPartyProfile,
  loadPartyProfiles,
  loadPolitician,
  loadPoliticiansByIds,
  loadPoliticiansForParty,
  loadPublishedClips,
  searchPoliticians
} from "./supabase";
import type {
  ClipItem,
  ClipSource,
  FeedMode,
  LibraryState,
  OnboardingState,
  PartyCode,
  PartyProfile,
  Politician,
  RecommendationProfile,
  Tab
} from "./types";

const NEW_ACCOUNT_QUERY = "pleni_new_account";

type OnboardingMode = "consent" | "interests";

/**
 * Build a fresh general-discovery slate without creating a viewer profile.
 * The source catalogue stays date ordered for `Senaste`; only `För dig` uses
 * this cryptographically seeded Fisher-Yates shuffle.
 */
function shuffledClips(clips: ClipItem[], limit = 60): ClipItem[] {
  const shuffled = [...clips];
  const entropy = new Uint32Array(shuffled.length);
  crypto.getRandomValues(entropy);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = entropy[index] % (index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, limit);
}

function downloadJson(value: Record<string, unknown>, filename: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function hasNewAccountRedirect(): boolean {
  return new URLSearchParams(window.location.search).get(NEW_ACCOUNT_QUERY) === "1";
}

function clearNewAccountRedirect(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(NEW_ACCOUNT_QUERY)) {
    return;
  }
  url.searchParams.delete(NEW_ACCOUNT_QUERY);
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
}

type BooleanMap = Record<string, boolean>;
type PlaybackFlash = { clipId: string; icon: "play" | "pause"; nonce: number };
type ShareOutcome = "shared" | "copied" | "cancelled" | "error";
type ShareFeedback = {
  clipId: string;
  kind: Exclude<ShareOutcome, "cancelled">;
  nonce: number;
};

const CANONICAL_APP_URL = "https://pleni.se/";

function canonicalClipUrl(clip: ClipItem): string {
  const url = new URL(CANONICAL_APP_URL);
  const params = new URLSearchParams({
    from: "hem",
    feed: "senaste",
    clip: clip.id
  });
  url.hash = clip.politicianId
    ? `/person/${encodeURIComponent(clip.politicianId)}/clips?${params.toString()}`
    : `/party/${encodeURIComponent(clip.party)}/clips?${params.toString()}`;
  return url.toString();
}

async function shareClip(clip: ClipItem): Promise<ShareOutcome> {
  const url = canonicalClipUrl(clip);
  const data: ShareData = {
    title: clip.title,
    text: `${clip.speakerName}: ${clip.title}`,
    url
  };
  const canUseNativeShare =
    typeof navigator.share === "function" &&
    (typeof navigator.canShare !== "function" || navigator.canShare(data));

  if (canUseNativeShare) {
    try {
      await navigator.share(data);
      return "shared";
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return "cancelled";
      }
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "error";
  }
}

/**
 * A feed scoped to something other than the catalogue: one politician's clips,
 * or the saved archive. Rendered through the same `FeedScreen` as the main
 * feed so there is exactly one player implementation.
 */
type ClipCollection = {
  title: string;
  subtitle: string;
  clips: ClipItem[];
  /** Clip to open on, when the viewer tapped a specific one in a grid. */
  startId: string | null;
};

const partyCodes = Object.keys(PARTIES).filter((code) => code !== "NONE") as PartyCode[];
const MAX_RECENT_SEARCHES = 4;

/**
 * Visible fraction that counts as seeing a clip (prerequisite T-8).
 *
 * Written down once and used both to pick the active clip and, later, to decide
 * what an impression is. A metric with two definitions is a metric with none.
 */
const IMPRESSION_VISIBLE_FRACTION = 0.72;

/**
 * How long a clip must hold the visibility lead before it becomes active
 * (prerequisite FE-4). Long enough that scrolling past does not activate,
 * short enough to feel instant when the viewer actually stops.
 */
const ACTIVATION_DWELL_MS = 180;

/**
 * How many clips either side of the active one carry a `poster`.
 *
 * Wider than the bounded source scheduler because a thumbnail is far cheaper and
 * it is what stands in for the clip until the first frame decodes — a poster
 * that arrives late shows as a black card. Still bounded: measured on a cold
 * load, all 60 posters together took 1,089 ms to finish and were competing with
 * the active clip's MP4 for the same six connections to the CDN. Windowing both
 * took the last CDN response from 2,796 ms to 966 ms.
 *
 * Safe at this width only because `scroll-snap-stop: always` now limits a
 * gesture to one clip, so the window cannot be outrun by a single swipe.
 */
const POSTER_WINDOW = 3;
const PULL_REFRESH_TRIGGER = 64;

function App() {
  const { route, navigate, backTo } = useAppNavigation();
  const tab = route.tab;
  const feedMode = route.feedMode;
  const darkSurface =
    (route.view === "tab" && tab === "hem") ||
    route.view === "person-clips" ||
    route.view === "party-clips" ||
    route.view === "saved-clips";
  // Starts empty, not seeded with demo clips (FE-1). A brief loading state is
  // honest; a flash of fabricated content that then becomes real is not.
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [clipSource, setClipSource] = useState<ClipSource>("supabase");
  const [feedError, setFeedError] = useState<string | null>(null);
  const [feedNetworkFailed, setFeedNetworkFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const manualRefreshRef = useRef(false);
  const preferenceSyncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [feedReloadKey, setFeedReloadKey] = useState(0);
  const pwa = usePwaExperience(feedNetworkFailed);
  const selectedPersonId =
    route.view === "person" || route.view === "person-clips" ? route.personId : null;
  const selectedPartyCode =
    route.view === "party" || route.view === "party-clips" ? route.partyCode : null;
  const [query, setQuery] = useState("");
  const [partyFilter, setPartyFilter] = useState<PartyCode | null>(null);
  const [muted, setMuted] = useState(false);
  // Follows, saves and likes now survive a reload. Device-local only — see
  // `library-store.ts` for why this is not a server call yet (C-1, C-2, C-6).
  const [library, setLibrary] = useState<LibraryState>(EMPTY_LIBRARY);
  // A scoped feed: one politician's clips, or the saved archive. Rendering it
  // through the same `FeedScreen` reuses the player, the FE-4 dwell activation
  // and the FE-3 loop instrumentation rather than growing a second one.
  const [collection, setCollection] = useState<ClipCollection | null>(null);
  const [person, setPerson] = useState<Politician | null>(null);
  const [personClips, setPersonClips] = useState<ClipItem[]>([]);
  const [personLoading, setPersonLoading] = useState(false);
  const [party, setParty] = useState<PartyProfile | null>(null);
  const [partyClips, setPartyClips] = useState<ClipItem[]>([]);
  const [partyPoliticians, setPartyPoliticians] = useState<Politician[]>([]);
  const [partyLoading, setPartyLoading] = useState(false);
  const [savedClips, setSavedClips] = useState<ClipItem[]>([]);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [savedLoading, setSavedLoading] = useState(false);
  // Onboarding answers and consent live together because the flow collects
  // both. Defaults are off; the server ledger receives explicit party and
  // follow choices only after rollout is enabled and the viewer grants it.
  const [onboarding, setOnboarding] = useState<OnboardingState>(EMPTY_ONBOARDING);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingMode, setOnboardingMode] = useState<OnboardingMode>("consent");
  const [openForYouAfterOnboarding, setOpenForYouAfterOnboarding] = useState(false);
  const [onboardingLoadedUserId, setOnboardingLoadedUserId] = useState<string | null>(null);
  const [libraryLoadedUserId, setLibraryLoadedUserId] = useState<string | null>(null);
  const [recommendationProfile, setRecommendationProfile] =
    useState<RecommendationProfile>(EMPTY_RECOMMENDATION_PROFILE);
  const [recommendationProfileLoaded, setRecommendationProfileLoaded] = useState(
    !recommendationsEnabled
  );
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [recommendationAction, setRecommendationAction] = useState<
    "export" | "reset" | "delete" | null
  >(null);
  const [recommendationActionMessage, setRecommendationActionMessage] = useState<string | null>(
    null
  );
  const [newAccountRedirect, setNewAccountRedirect] = useState(hasNewAccountRedirect);
  const viewer = useViewer();
  const consent = {
    ...onboarding.consent,
    personal: recommendationsEnabled
      ? recommendationProfile.personalization
      : onboarding.consent.personal
  };

  useLayoutEffect(() => {
    applyBrowserTheme(darkSurface ? "dark" : "light");
  }, [darkSurface]);

  useEffect(() => {
    if (!viewer.signedIn || !viewer.userId) {
      setOnboarding(EMPTY_ONBOARDING);
      setOnboardingLoadedUserId(null);
      setShowOnboarding(false);
      return;
    }
    const stored = readOnboarding(viewer.userId);
    setOnboarding(stored);
    setOnboardingLoadedUserId(viewer.userId);
    // Missing local state alone does not mean the account is new. Clerk can
    // restore an existing session on app launch, including on another device.
    // The flow opens only after Clerk's completed-sign-up redirect and only
    // when this is genuinely the account's first sign-in session.
    const shouldShow =
      newAccountRedirect && viewer.newAccountSession && stored.completedAt === null;
    if (shouldShow) {
      setOnboardingMode("consent");
    }
    setShowOnboarding(shouldShow);
    if (newAccountRedirect && !shouldShow) {
      clearNewAccountRedirect();
      setNewAccountRedirect(false);
    }
  }, [newAccountRedirect, viewer.newAccountSession, viewer.signedIn, viewer.userId]);

  // The server ledger is authoritative whenever the recommendation rollout is
  // enabled. Legacy device-local consent is never uploaded automatically: the
  // older notice promised that those choices stayed on this device.
  useEffect(() => {
    if (!recommendationsEnabled) {
      setRecommendationProfileLoaded(true);
      return;
    }
    if (!viewer.signedIn || !viewer.userId) {
      setRecommendationProfile(EMPTY_RECOMMENDATION_PROFILE);
      setRecommendationProfileLoaded(true);
      setRecommendationError(null);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setRecommendationProfileLoaded(false);
    setRecommendationError(null);
    void loadRecommendationProfile(viewer.getAccessToken, controller.signal)
      .then((profile) => {
        if (!active) return;
        setRecommendationProfile(profile);
        setOnboarding((current) => ({
          ...current,
          parties: profile.personalization ? profile.explicitParties : current.parties,
          consent: { ...current.consent, personal: profile.personalization }
        }));
        // Existing accounts have never seen the server-backed V2 notice. Show
        // the optional choice once on their next open; either answer writes the
        // notice version, so it does not become a recurring prompt.
        if (!profile.personalization && profile.noticeVersion !== PERSONALIZATION_NOTICE_VERSION) {
          setOpenForYouAfterOnboarding(true);
          setOnboardingMode("consent");
          setShowOnboarding(true);
        }
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setRecommendationProfile(EMPTY_RECOMMENDATION_PROFILE);
        setRecommendationError(
          error instanceof RecommendationApiError && error.code === "sign_in_required"
            ? "Logga in igen för att läsa dina rekommendationsval."
            : "Kunde inte läsa dina rekommendationsval. Ett allmänt För dig visas tills vidare."
        );
      })
      .finally(() => {
        if (active) setRecommendationProfileLoaded(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [viewer.signedIn, viewer.userId]);

  /**
   * The library belongs to an account, not to a device.
   *
   * Following politicians and saving clips are the inputs to a political
   * recommendation system, so they are only collected for someone who has asked
   * for them by signing up. An anonymous viewer gets the full feed and no
   * profile — `Senaste` must keep working signed out, which is the acceptance
   * criterion F1 states.
   */
  // Load on sign-in, drop on sign-out. Reading is keyed on the account, so
  // switching users on a shared device swaps the library rather than merging it.
  useEffect(() => {
    if (viewer.signedIn && viewer.userId) {
      setLibrary(readLibrary(viewer.userId));
      setLibraryLoadedUserId(viewer.userId);
    } else {
      setLibrary(EMPTY_LIBRARY);
      setLibraryLoadedUserId(null);
    }
  }, [viewer.signedIn, viewer.userId]);

  /**
   * The single funnel every follow, save and like passes through, and therefore
   * the only place the gate has to exist. A signed-out tap opens Clerk's modal
   * and writes nothing — no optimistic local state that would have to be
   * reconciled, and no anonymous row to migrate later.
   */
  const updateLibrary = (update: (current: LibraryState) => LibraryState) => {
    if (!viewer.signedIn) {
      viewer.requireSignIn();
      return;
    }
    setLibrary((current) => {
      const next = update(current);
      writeLibrary(viewer.userId, next);
      return next;
    });
  };

  const toggleFollowPolitician = (politicianId: string) =>
    updateLibrary((current) => ({
      ...current,
      followedPoliticians: toggleInList(current.followedPoliticians, politicianId)
    }));

  const toggleFollowParty = (party: PartyCode) =>
    updateLibrary((current) => ({
      ...current,
      followedParties: toggleInList(current.followedParties, party)
    }));

  const toggleSaveClip = (clipId: string) =>
    updateLibrary((current) => ({
      ...current,
      // Newest save first, so the archive reads like a stack rather than a log.
      savedClips: current.savedClips.includes(clipId)
        ? current.savedClips.filter((id) => id !== clipId)
        : [clipId, ...current.savedClips]
    }));

  const toggleLikeClip = (clipId: string) =>
    updateLibrary((current) => ({
      ...current,
      likedClips: toggleInList(current.likedClips, clipId)
    }));

  // Lookup maps, so the render path does not run `Array.includes` per clip.
  const liked = useMemo(
    () => Object.fromEntries(library.likedClips.map((id) => [id, true])),
    [library.likedClips]
  );
  const saved = useMemo(
    () => Object.fromEntries(library.savedClips.map((id) => [id, true])),
    [library.savedClips]
  );
  const following = useMemo(
    () => Object.fromEntries(library.followedPoliticians.map((id) => [id, true])),
    [library.followedPoliticians]
  );
  const followedParties = useMemo(
    () => Object.fromEntries(library.followedParties.map((code) => [code, true])) as Record<
      PartyCode,
      boolean
    >,
    [library.followedParties]
  );

  const saveOnboarding = (next: OnboardingState) => {
    setOnboarding(next);
    writeOnboarding(viewer.userId, next);
  };

  const preferencePayload = (
    parties: PartyCode[] = onboarding.parties,
    currentLibrary: LibraryState = library
  ) => ({
    parties,
    followedParties: currentLibrary.followedParties,
    followedPoliticians: currentLibrary.followedPoliticians
  });

  const completeOnboarding = async (next: OnboardingState): Promise<void> => {
    if (!recommendationsEnabled) {
      saveOnboarding(next);
      setFeedReloadKey((current) => current + 1);
      return;
    }
    if (!viewer.signedIn) {
      viewer.requireSignIn();
      throw new Error("sign_in_required");
    }
    const profile = await setRecommendationConsent(
      next.consent.personal,
      preferencePayload(next.parties),
      "onboarding",
      viewer.getAccessToken
    );
    setRecommendationProfile(profile);
    setRecommendationProfileLoaded(true);
    setRecommendationError(null);
    saveOnboarding({
      ...next,
      parties: profile.personalization ? profile.explicitParties : next.parties,
      consent: { ...next.consent, personal: profile.personalization }
    });
    setFeedReloadKey((current) => current + 1);
  };

  const saveEditedInterests = async (next: OnboardingState): Promise<void> => {
    if (!recommendationsEnabled || !recommendationProfile.personalization) {
      saveOnboarding(next);
      setFeedReloadKey((current) => current + 1);
      return;
    }
    if (!viewer.signedIn) {
      viewer.requireSignIn();
      throw new Error("sign_in_required");
    }
    const profile = await syncRecommendationPreferences(
      preferencePayload(next.parties),
      viewer.getAccessToken
    );
    setRecommendationProfile(profile);
    setRecommendationError(null);
    saveOnboarding({
      ...next,
      parties: profile.explicitParties,
      consent: { ...next.consent, personal: profile.personalization }
    });
    setFeedReloadKey((current) => current + 1);
  };

  const withdrawPersonalization = async (): Promise<void> => {
    try {
      const profile = await setRecommendationConsent(
        false,
        { parties: [], followedParties: [], followedPoliticians: [] },
        "profile",
        viewer.getAccessToken
      );
      setRecommendationProfile(profile);
      setRecommendationError(null);
      saveOnboarding({
        ...onboarding,
        consent: { ...onboarding.consent, personal: false }
      });
      setFeedReloadKey((current) => current + 1);
    } catch {
      setRecommendationError("Kunde inte stänga av personalisering. Försök igen.");
    }
  };

  const exportMyRecommendationData = async (): Promise<void> => {
    setRecommendationAction("export");
    setRecommendationActionMessage(null);
    setRecommendationError(null);
    try {
      const exported = await exportRecommendationData(viewer.getAccessToken);
      downloadJson(exported, `pleni-rekommendationsdata-${new Date().toISOString().slice(0, 10)}.json`);
      setRecommendationActionMessage("Exporten har hämtats till din enhet.");
    } catch {
      setRecommendationError("Kunde inte exportera rekommendationsdata. Försök igen.");
    } finally {
      setRecommendationAction(null);
    }
  };

  const resetMyRecommendationData = async (): Promise<void> => {
    if (!window.confirm("Återställ dina rekommendationer och radera sparade listor från Plenis server?")) {
      return;
    }
    setRecommendationAction("reset");
    setRecommendationActionMessage(null);
    setRecommendationError(null);
    try {
      const profile = await resetRecommendationData(viewer.getAccessToken);
      setRecommendationProfile(profile);
      saveOnboarding({
        ...onboarding,
        parties: [],
        consent: { ...onboarding.consent, personal: false }
      });
      setFeedReloadKey((current) => current + 1);
      setRecommendationActionMessage("Rekommendationerna är återställda och personalisering är avstängd.");
    } catch {
      setRecommendationError("Kunde inte återställa rekommendationerna. Försök igen.");
    } finally {
      setRecommendationAction(null);
    }
  };

  const deleteMyRecommendationData = async (): Promise<void> => {
    if (!window.confirm("Radera all rekommendationsdata hos Pleni? Ditt Clerk-konto och lokala bibliotek påverkas inte.")) {
      return;
    }
    setRecommendationAction("delete");
    setRecommendationActionMessage(null);
    setRecommendationError(null);
    try {
      await deleteRecommendationData(viewer.getAccessToken);
      setRecommendationProfile(EMPTY_RECOMMENDATION_PROFILE);
      saveOnboarding({
        ...onboarding,
        parties: [],
        consent: { ...onboarding.consent, personal: false }
      });
      setFeedReloadKey((current) => current + 1);
      setRecommendationActionMessage("All rekommendationsdata hos Pleni har raderats.");
    } catch {
      setRecommendationError("Kunde inte radera rekommendationsdata. Försök igen.");
    } finally {
      setRecommendationAction(null);
    }
  };

  const changeFeedMode = (nextMode: FeedMode) => {
    navigate({ view: "tab", tab: "hem", feedMode: nextMode });
  };

  const refreshFeed = () => {
    if (loading) return;
    manualRefreshRef.current = true;
    setManualRefreshing(true);
    setLoading(true);
    setFeedReloadKey((current) => current + 1);
  };

  // A changed follow or onboarding party is synced only after the account,
  // local caches and server consent have all loaded. Likes/saves are not inputs
  // to this explicit-only V1 and therefore do not leave the device.
  useEffect(() => {
    if (
      !recommendationsEnabled ||
      !recommendationProfile.personalization ||
      !viewer.userId ||
      onboardingLoadedUserId !== viewer.userId ||
      libraryLoadedUserId !== viewer.userId
    ) {
      return;
    }
    const preferences = preferencePayload();
    let active = true;
    // A follow is an input to the *next* slate, not permission to replace the
    // video someone is currently watching. Briefly settle rapid taps, then run
    // writes in order so an older follow/unfollow request cannot finish last.
    const timer = window.setTimeout(() => {
      const syncPreferences = async () => {
        if (!active) return;
        try {
          const profile = await syncRecommendationPreferences(
            preferences,
            viewer.getAccessToken
          );
          if (!active) return;
          setRecommendationProfile(profile);
          setRecommendationError(null);
        } catch (error: unknown) {
          if (!active) return;
          setRecommendationError(
            error instanceof RecommendationApiError &&
              error.code === "personalization_consent_required"
              ? "Personaliseringen har stängts av. Ett allmänt För dig används."
              : "Ett följval kunde inte synkroniseras. Försök igen om en stund."
          );
        }
      };
      preferenceSyncQueueRef.current = preferenceSyncQueueRef.current.then(
        syncPreferences,
        syncPreferences
      );
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    library.followedParties,
    library.followedPoliticians,
    libraryLoadedUserId,
    onboarding.parties,
    onboardingLoadedUserId,
    recommendationProfile.personalization,
    viewer.userId
  ]);

  useEffect(() => {
    if (recommendationsEnabled && feedMode === "fordig" && !recommendationProfileLoaded) {
      setLoading(true);
      return;
    }
    let mounted = true;
    const controller = new AbortController();
    const personalized =
      recommendationsEnabled &&
      feedMode === "fordig" &&
      viewer.signedIn &&
      recommendationProfile.personalization;
    setLoading(true);
    setFeedError(null);
    // Pull/Home refresh keeps the current frame in place until its replacement
    // is ready. Mode and preference changes still clear immediately so content
    // from the previous context is never presented as the new feed.
    if (!manualRefreshRef.current) {
      setClips([]);
    }
    void (async () => {
      try {
        if (personalized) {
          return await loadRuleBasedFeed(viewer.getAccessToken, {
            limit: 60,
            clientRequestId: crypto.randomUUID(),
            signal: controller.signal
          });
        }
        const published = await loadPublishedClips(feedMode === "fordig" ? 240 : 60);
        return feedMode === "fordig"
          ? { ...published, clips: shuffledClips(published.clips) }
          : published;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (personalized) {
          const fallback = await loadPublishedClips(240);
          return {
            ...fallback,
            clips: shuffledClips(fallback.clips),
            error:
              fallback.error ??
              "Personaliseringen är tillfälligt otillgänglig. Ett allmänt För dig visas."
          };
        }
        throw error;
      }
    })()
      .then((feed) => {
        if (!mounted) return;
        setClips(feed.clips);
        setClipSource(feed.source);
        setFeedError(feed.error ?? null);
        setFeedNetworkFailed(Boolean(feed.error));
      })
      .catch((error: unknown) => {
        if (!mounted || controller.signal.aborted) return;
        setClips([]);
        setFeedError(error instanceof Error ? error.message : "Okänt fel");
        setFeedNetworkFailed(true);
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
          if (manualRefreshRef.current) {
            manualRefreshRef.current = false;
            setManualRefreshing(false);
          }
        }
      });
    return () => {
      mounted = false;
      controller.abort();
    };
  }, [
    feedMode,
    feedReloadKey,
    recommendationProfile.personalization,
    recommendationProfileLoaded,
    viewer.signedIn,
    viewer.userId
  ]);

  /**
   * The open person page, loaded from `public.politicians` rather than derived
   * from the feed.
   *
   * A politician the viewer searched for or follows is usually *not* among the
   * 60 most recent clips, so deriving them from the loaded feed — as this used
   * to — meant most people simply could not be opened.
   */
  useEffect(() => {
    if (selectedPersonId === null) {
      setPerson(null);
      setPersonClips([]);
      return;
    }
    let active = true;
    setPersonLoading(true);
    setPerson(null);
    setPersonClips([]);
    Promise.all([loadPolitician(selectedPersonId), loadClipsForPolitician(selectedPersonId)])
      .then(([politician, personClips]) => {
        if (active) {
          setPerson(politician);
          setPersonClips(personClips);
        }
      })
      .catch(() => {
        if (active) {
          setPerson(null);
          setPersonClips([]);
        }
      })
      .finally(() => {
        if (active) {
          setPersonLoading(false);
        }
      });
    return () => {
      // A fast tap through several people must not let a slow first response
      // overwrite a newer one.
      active = false;
    };
  }, [selectedPersonId]);

  /** Load a party's canonical metadata, current people and recent catalogue. */
  useEffect(() => {
    if (selectedPartyCode === null) {
      setParty(null);
      setPartyClips([]);
      setPartyPoliticians([]);
      return;
    }
    let active = true;
    setPartyLoading(true);
    setParty(null);
    setPartyClips([]);
    setPartyPoliticians([]);
    Promise.all([
      loadPartyProfile(selectedPartyCode),
      loadClipsForParty(selectedPartyCode),
      loadPoliticiansForParty(selectedPartyCode)
    ])
      .then(([profile, recentClips, politicians]) => {
        if (active) {
          setParty(profile);
          setPartyClips(recentClips);
          setPartyPoliticians(politicians);
        }
      })
      .catch(() => {
        if (active) {
          setParty(null);
          setPartyClips([]);
          setPartyPoliticians([]);
        }
      })
      .finally(() => {
        if (active) {
          setPartyLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [selectedPartyCode]);

  const openPerson = (personId: string) => {
    setCollection(null);
    navigate({ view: "person", tab, feedMode, personId });
  };

  const closePerson = () => {
    backTo({ view: "tab", tab, feedMode });
  };

  const openParty = (partyCode: PartyCode) => {
    if (partyCode === "NONE") {
      return;
    }
    setCollection(null);
    navigate({ view: "party", tab, feedMode, partyCode });
  };

  const closeParty = () => {
    backTo({ view: "tab", tab, feedMode });
  };

  /** Play a politician's clips, optionally starting on one the viewer tapped. */
  const openPersonClips = (startId: string | null) => {
    if (person === null || personClips.length === 0) {
      return;
    }
    navigate({ view: "person-clips", tab, feedMode, personId: person.id, startId });
  };

  /** Play the selected party's recent clips, preserving the tapped position. */
  const openPartyClips = (startId: string | null) => {
    if (party === null || partyClips.length === 0) {
      return;
    }
    navigate({ view: "party-clips", tab, feedMode, partyCode: party.abbr, startId });
  };

  const openSavedArchive = () => {
    navigate({ view: "saved", tab: "profil", feedMode });
  };

  const openSavedClip = (startId: string) => {
    if (savedClips.length === 0) {
      return;
    }
    navigate({ view: "saved-clips", tab: "profil", feedMode, startId });
  };

  const openFollowing = () => {
    navigate({ view: "tab", tab: "foljer", feedMode });
  };

  const openLegal = (page: LegalPageId) => {
    navigate({ view: "legal", tab: "profil", feedMode, page });
  };

  useEffect(() => {
    if (route.view === "person-clips") {
      setCollection({
        title: person ? cleanName(person.name) || person.name : "Klipp",
        subtitle: personLoading ? "Laddar…" : `${personClips.length} klipp`,
        clips: personClips,
        startId: route.startId
      });
      return;
    }
    if (route.view === "party-clips") {
      setCollection({
        title: party?.name ?? PARTIES[route.partyCode].name,
        subtitle: partyLoading ? "Laddar…" : `${partyClips.length} senaste klipp`,
        clips: partyClips,
        startId: route.startId
      });
      return;
    }
    if (route.view === "saved-clips") {
      setCollection({
        title: "Sparade klipp",
        subtitle: savedLoading
          ? "Laddar…"
          : savedError ?? `${savedClips.length} sparade klipp`,
        clips: savedClips,
        startId: route.startId
      });
      return;
    }
    setCollection(null);
  }, [
    party,
    partyClips,
    partyLoading,
    person,
    personClips,
    personLoading,
    route,
    savedClips,
    savedError,
    savedLoading
  ]);

  useEffect(() => {
    if (route.view !== "saved" && route.view !== "saved-clips") {
      return;
    }
    let active = true;
    setSavedLoading(true);
    setSavedError(null);
    if (library.savedClips.length === 0) {
      setSavedClips([]);
      setSavedLoading(false);
      return;
    }
    loadClipsByIds(library.savedClips)
      .then((loadedClips) => {
        if (active) {
          setSavedClips(loadedClips);
        }
      })
      .catch(() => {
        if (active) {
          setSavedClips([]);
          setSavedError("Klippen kunde inte hämtas");
        }
      })
      .finally(() => {
        if (active) {
          setSavedLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [library.savedClips, route.view]);

  return (
    <>
      <WideScreenMessage />
      <PwaStatusStack pwa={pwa} />
      {viewer.signedIn && showOnboarding && (
        <Onboarding
          initial={onboarding}
          mode={onboardingMode}
          recommendationsConnected={recommendationsEnabled}
          onComplete={async (next) => {
            if (onboardingMode === "interests") {
              await saveEditedInterests(next);
            } else {
              await completeOnboarding(next);
              clearNewAccountRedirect();
            }
          }}
          onSkip={() => {
            if (onboardingMode === "interests") {
              setShowOnboarding(false);
              return;
            }
            void (async () => {
              let currentProfile = recommendationProfile;
              if (
                recommendationsEnabled &&
                !currentProfile.personalization &&
                currentProfile.noticeVersion !== PERSONALIZATION_NOTICE_VERSION
              ) {
                try {
                  currentProfile = await setRecommendationConsent(
                    false,
                    { parties: [], followedParties: [], followedPoliticians: [] },
                    "onboarding",
                    viewer.getAccessToken
                  );
                  setRecommendationProfile(currentProfile);
                  setRecommendationError(null);
                } catch {
                  setRecommendationError("Kunde inte spara ditt val. Försök igen.");
                  return;
                }
              }
              setShowOnboarding(false);
              clearNewAccountRedirect();
              setNewAccountRedirect(false);
              if (openForYouAfterOnboarding && currentProfile.personalization) {
                navigate({ view: "tab", tab: "hem", feedMode: "fordig" });
              }
              setOpenForYouAfterOnboarding(false);
              // A skip is an answer. Stamping it stops the flow reappearing on
              // every load; Profil has a row to reopen it deliberately.
              if (onboarding.completedAt === null) {
                saveOnboarding({ ...onboarding, completedAt: new Date().toISOString() });
              }
            })();
          }}
        />
      )}
      <main className="mobile-app" aria-label="Pleni">
        {route.view === "legal" ? (
          <LegalScreen
            page={route.page}
            onBack={() => backTo({ view: "tab", tab: "profil", feedMode })}
            onNavigate={openLegal}
          />
        ) : route.view === "person-clips" || route.view === "party-clips" || route.view === "saved-clips" ? (
          <CollectionScreen
            collection={
              collection ?? { title: "Klipp", subtitle: "Laddar…", clips: [], startId: null }
            }
            onBack={() =>
              backTo(
                route.view === "saved-clips"
                  ? { view: "saved", tab: "profil", feedMode }
                  : { view: "tab", tab, feedMode }
              )
            }
            muted={muted}
            setMuted={setMuted}
            liked={liked}
            saved={saved}
            following={following}
            onLike={toggleLikeClip}
            onSave={toggleSaveClip}
            onToggleFollow={toggleFollowPolitician}
            onOpenPerson={openPerson}
          />
        ) : route.view === "saved" ? (
          <SavedScreen
            clips={savedClips}
            loading={savedLoading}
            error={savedError}
            onBack={() => backTo({ view: "tab", tab: "profil", feedMode })}
            onPlayClip={openSavedClip}
          />
        ) : route.view === "person" && selectedPersonId !== null ? (
          <PersonScreen
            person={person}
            clips={personClips}
            loading={personLoading}
            onBack={closePerson}
            following={!!following[selectedPersonId]}
            onToggleFollow={() => toggleFollowPolitician(selectedPersonId)}
            onPlayClip={openPersonClips}
          />
        ) : route.view === "party" && selectedPartyCode !== null ? (
          <PartyScreen
            party={party}
            clips={partyClips}
            politicians={partyPoliticians}
            loading={partyLoading}
            onBack={closeParty}
            following={!!followedParties[selectedPartyCode]}
            onToggleFollow={() => toggleFollowParty(selectedPartyCode)}
            onPlayClip={openPartyClips}
            onOpenPerson={openPerson}
          />
        ) : (
          <>
            {tab === "hem" && (
              <FeedScreen
                clips={clips}
                feedMode={feedMode}
                setFeedMode={changeFeedMode}
                playbackSuspended={showOnboarding}
                muted={muted}
                setMuted={setMuted}
                liked={liked}
                saved={saved}
                following={following}
                loading={loading}
                clipSource={clipSource}
                feedError={feedError}
                onRefresh={refreshFeed}
                refreshing={manualRefreshing}
                onLike={toggleLikeClip}
                onSave={toggleSaveClip}
                onToggleFollow={toggleFollowPolitician}
                onOpenPerson={openPerson}
              />
            )}
            {tab === "foljer" && (
              <FollowingScreen
                followedPoliticians={library.followedPoliticians}
                followedParties={library.followedParties}
                onOpenPerson={openPerson}
                onOpenParty={openParty}
                onTogglePerson={toggleFollowPolitician}
                onToggleParty={toggleFollowParty}
              />
            )}
            {tab === "sok" && (
              <SearchScreen
                query={query}
                setQuery={setQuery}
                partyFilter={partyFilter}
                setPartyFilter={setPartyFilter}
                onOpenPerson={openPerson}
                onOpenParty={openParty}
              />
            )}
            {tab === "profil" && (
              <ProfileScreen
                consent={consent}
                selectedParties={onboarding.parties.length}
                savedCount={library.savedClips.length}
                followedCount={library.followedPoliticians.length}
                followedPartyCount={library.followedParties.length}
                savedLoading={savedLoading}
                onOpenSaved={openSavedArchive}
                onOpenFollowing={() =>
                  viewer.signedIn ? openFollowing() : viewer.requireSignIn()
                }
                onEditInterests={() => {
                  if (!viewer.signedIn) {
                    viewer.requireSignIn();
                    return;
                  }
                  setOpenForYouAfterOnboarding(false);
                  setOnboardingMode("interests");
                  setShowOnboarding(true);
                }}
                onToggleConsent={(key) => {
                  if (!viewer.signedIn) {
                    viewer.requireSignIn();
                    return;
                  }
                  if (key !== "personal" || !recommendationsEnabled) {
                    saveOnboarding({
                      ...onboarding,
                      consent: { ...onboarding.consent, [key]: !onboarding.consent[key] }
                    });
                    return;
                  }
                  if (recommendationProfile.personalization) {
                    void withdrawPersonalization();
                  } else {
                    setOpenForYouAfterOnboarding(false);
                    setOnboardingMode("consent");
                    setShowOnboarding(true);
                  }
                }}
                recommendationsConnected={recommendationsEnabled}
                recommendationError={recommendationError}
                recommendationAction={recommendationAction}
                recommendationActionMessage={recommendationActionMessage}
                onExportRecommendationData={() => void exportMyRecommendationData()}
                onResetRecommendationData={() => void resetMyRecommendationData()}
                onDeleteRecommendationData={() => void deleteMyRecommendationData()}
                onOpenLegal={openLegal}
                pwa={pwa}
              />
            )}
            <BottomNav
              active={tab}
              onChange={(nextTab) => {
                if (nextTab === "hem") {
                  refreshFeed();
                }
                navigate({ view: "tab", tab: nextTab, feedMode });
              }}
            />
          </>
        )}
      </main>
    </>
  );
}

function WideScreenMessage() {
  return (
    <section className="wide-message">
      <div className="wide-panel">
        <div className="wide-kicker">Pleni</div>
        <h1>Öppna appen på en mobilskärm.</h1>
        <p>Den första versionen är byggd för en fullskärms 9:16-feed. Surfa från mobilen för hela upplevelsen.</p>
      </div>
    </section>
  );
}

function PwaStatusStack({ pwa }: { pwa: PwaExperience }) {
  const showUpdate = pwa.standalone && pwa.updatePhase !== "hidden";

  if (!showUpdate && pwa.offlineMessage === null) {
    return null;
  }

  const updateCopy =
    pwa.updatePhase === "deferred"
      ? {
          title: "Uppdateringen väntar",
          detail: "Slutför eller rensa kommentaren för att fortsätta."
        }
      : pwa.updatePhase === "preparing" || pwa.updatePhase === "activating"
        ? { title: "Pleni uppdateras", detail: "Videon är pausad. Appen startas om strax." }
        : pwa.updatePhase === "completed"
          ? { title: "Pleni är uppdaterad", detail: "Du använder nu den senaste versionen." }
          : { title: "Ny version klar", detail: "Uppdatera när det passar." };

  const UpdateIcon = pwa.updatePhase === "completed" ? CheckCircle2 : RefreshCw;
  const updateInProgress =
    pwa.updatePhase === "preparing" || pwa.updatePhase === "activating";

  return (
    <div className="pwa-status-stack">
      {showUpdate && (
        <div className="pwa-notice">
          <UpdateIcon
            className={
              pwa.updatePhase === "activating"
                ? "pwa-notice-icon pwa-spinner"
                : "pwa-notice-icon"
            }
            size={18}
            aria-hidden="true"
          />
          {updateInProgress && (
            <span
              className={`pwa-update-progress${
                pwa.updatePhase === "activating" ? " is-complete" : ""
              }`}
              aria-hidden="true"
            >
              <span />
            </span>
          )}
          <div className="pwa-notice-copy" role="status" aria-atomic="true">
            <strong>{updateCopy.title}</strong>
            <span>{updateCopy.detail}</span>
          </div>
          {pwa.updatePhase === "available" && (
            <>
              <button type="button" className="pwa-notice-action" onClick={pwa.requestUpdate}>
                Uppdatera
              </button>
              <button
                type="button"
                className="pwa-notice-close"
                aria-label="Stäng uppdateringsmeddelandet"
                onClick={pwa.dismissUpdate}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      )}
      {pwa.offlineMessage && (
        <div className="pwa-notice">
          <WifiOff className="pwa-notice-icon" size={18} aria-hidden="true" />
          <div className="pwa-notice-copy" role="status" aria-atomic="true">
            <span>{pwa.offlineMessage}</span>
          </div>
          <button
            type="button"
            className="pwa-notice-close"
            aria-label="Stäng nätverksmeddelandet"
            onClick={pwa.dismissOffline}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Own the high-frequency media clock for one row. A video emits time updates
 * several times a second; keeping them here means the active row can refresh
 * its progress bar without rebuilding every sibling in the catalogue.
 */
function FeedItemRow({
  clip,
  person,
  videoRef,
  videoSrc,
  posterSrc,
  preload,
  muted,
  active,
  blocked,
  liked,
  saved,
  following,
  flashIcon,
  flashNonce,
  shareFeedback,
  mediaMounted,
  onTogglePlayback,
  onToggleMuted,
  onLike,
  onComments,
  onSave,
  onShare,
  onOpenPerson,
  onToggleFollow,
  onEnded,
  onPlay,
  onPause,
  onPlayable,
  onSeek
}: {
  clip: ClipItem;
  person: Politician | null;
  videoRef: (node: HTMLVideoElement | null) => void;
  videoSrc: string | undefined;
  posterSrc: string | undefined;
  preload: "auto" | "metadata";
  muted: boolean;
  active: boolean;
  blocked: boolean;
  liked: boolean;
  saved: boolean;
  following: boolean;
  flashIcon: PlaybackFlash["icon"] | null;
  flashNonce: number | null;
  shareFeedback: ShareFeedback | null;
  mediaMounted: boolean;
  onTogglePlayback: () => void;
  onToggleMuted: () => void;
  onLike: () => void;
  onComments: () => void;
  onSave: () => void;
  onShare: () => void;
  onOpenPerson: () => void;
  onToggleFollow: () => void;
  onEnded: (video: HTMLVideoElement) => void;
  onPlay: () => void;
  onPause: () => void;
  onPlayable: () => void;
  onSeek: (seconds: number) => number | null;
}) {
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(clip.durationS);
  const [frameReady, setFrameReady] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const firstFrameCancelRef = useRef<(() => void) | null>(null);
  const bindMediaRef = useCallback(
    (node: HTMLVideoElement | null) => {
      mediaRef.current = node;
      videoRef(node);
    },
    [videoRef]
  );

  useEffect(() => {
    setCurrentTime(0);
    setDuration(clip.durationS);
    setFrameReady(false);
    setBuffering(false);
  }, [clip.id, clip.durationS, videoSrc]);

  useEffect(() => {
    if (!active) {
      setBuffering(false);
    }
  }, [active]);

  useLayoutEffect(() => {
    const video = mediaRef.current;
    if (!video || !videoSrc) {
      return;
    }
    setFrameReady(false);
    setBuffering(false);
    attachMediaSource(video, videoSrc, preload);
    return () => {
      firstFrameCancelRef.current?.();
      firstFrameCancelRef.current = null;
      releaseMediaSource(video);
    };
  }, [videoSrc]);

  useEffect(() => {
    const video = mediaRef.current;
    if (!video || !videoSrc || video.preload === preload) {
      return;
    }
    // Promotion from neighbor to active must keep the bytes already buffered.
    video.preload = preload;
    video.setAttribute("preload", preload);
  }, [preload, videoSrc]);

  const revealFirstFrame = (video: HTMLVideoElement) => {
    firstFrameCancelRef.current?.();
    const candidate = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    if (candidate.requestVideoFrameCallback) {
      const handle = candidate.requestVideoFrameCallback(() => {
        if (mediaRef.current === video) {
          setFrameReady(true);
        }
      });
      firstFrameCancelRef.current = () => candidate.cancelVideoFrameCallback?.(handle);
      return;
    }
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (mediaRef.current === video) {
          setFrameReady(true);
        }
      });
    });
    firstFrameCancelRef.current = () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  };

  return (
    <article
      className="feed-item"
      data-clip-id={clip.id}
      /* Q-2 QA hook, same purpose as `data-clip-id` for the FE-4
         activation harness: the identity a follow keys on has to be
         checkable from outside without reading React state. Empty
         string means the speaker has no stable id. */
      data-politician-id={clip.politicianId ?? ""}
      onClick={onTogglePlayback}
    >
      {posterSrc && !frameReady && <img className="feed-poster" src={posterSrc} alt="" />}
      {mediaMounted && (
        <video
          ref={bindMediaRef}
          poster={posterSrc}
          playsInline
          controls={false}
          controlsList="nodownload nofullscreen noremoteplayback"
          disablePictureInPicture
          disableRemotePlayback
          muted={muted}
          /* FE-3 (GATE): the explicit onEnded path keeps completion and replay
             observable instead of hiding the boundary behind native looping. */
          preload={preload}
          onLoadedMetadata={(event) => {
            const mediaDuration = event.currentTarget.duration;
            setDuration(
              Number.isFinite(mediaDuration) && mediaDuration > 0
                ? mediaDuration
                : clip.durationS
            );
          }}
          onLoadedData={(event) => {
            setBuffering(false);
            revealFirstFrame(event.currentTarget);
          }}
          onCanPlay={(event) => {
            setBuffering(false);
            revealFirstFrame(event.currentTarget);
            onPlayable();
          }}
          onPlaying={(event) => {
            setBuffering(false);
            revealFirstFrame(event.currentTarget);
          }}
          onWaiting={(event) => {
            if (
              active &&
              !event.currentTarget.paused &&
              event.currentTarget.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
            ) {
              setBuffering(true);
            }
          }}
          onStalled={(event) => {
            if (
              active &&
              !event.currentTarget.paused &&
              event.currentTarget.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
            ) {
              setBuffering(true);
            }
          }}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onEnded={(event) => {
            setBuffering(false);
            onEnded(event.currentTarget);
          }}
          onPlay={onPlay}
          onPause={() => {
            setBuffering(false);
            onPause();
          }}
          onError={() => setBuffering(false)}
          onClick={(event) => {
            // Consume the media element's own click before an Android browser
            // can interpret it as a request for its native UI.
            event.preventDefault();
            event.stopPropagation();
            onTogglePlayback();
          }}
          onContextMenu={(event) => event.preventDefault()}
        />
      )}
      {active && buffering && !blocked && (
        <div className="video-buffering" role="status" aria-label="Laddar video">
          <LoaderCircle size={24} aria-hidden="true" />
        </div>
      )}
      {flashIcon && flashNonce !== null && (
        <PlaybackFlashIcon key={flashNonce} icon={flashIcon} />
      )}
      {/* FE-5: only shown when browser policy refused playback itself, never
          for a pause the viewer chose. */}
      {blocked && active && (
        <button
          className="center-play"
          aria-label="Spela upp"
          onClick={(event) => {
            event.stopPropagation();
            onTogglePlayback();
          }}
        >
          <Play size={30} fill="currentColor" />
        </button>
      )}
      <button
        className="mute-button"
        aria-label={muted ? "Slå på ljud" : "Stäng av ljud"}
        onClick={(event) => {
          event.stopPropagation();
          onToggleMuted();
        }}
      >
        {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
      </button>
      <ActionRail
        clip={clip}
        liked={liked}
        saved={saved}
        onLike={onLike}
        onComments={onComments}
        onSave={onSave}
        onShare={onShare}
        shareFeedback={shareFeedback}
      />
      <ClipMeta
        clip={clip}
        person={person}
        following={following}
        onOpenPerson={onOpenPerson}
        onToggleFollow={onToggleFollow}
      />
      <ProgressRow
        currentTime={currentTime}
        duration={duration}
        onSeek={(seconds) => {
          const nextTime = onSeek(seconds);
          if (nextTime !== null) {
            setCurrentTime(nextTime);
          }
        }}
      />
    </article>
  );
}

function FeedScreen({
  clips,
  feedMode,
  setFeedMode,
  playbackSuspended = false,
  muted,
  setMuted,
  liked,
  saved,
  following,
  loading,
  clipSource,
  feedError,
  onRefresh,
  refreshing = false,
  onLike,
  onSave,
  onToggleFollow,
  onOpenPerson,
  header,
  initialClipId = null,
  emptyMessage
}: {
  clips: ClipItem[];
  feedMode: FeedMode;
  setFeedMode: (mode: FeedMode) => void;
  /** Keeps the visible frame in place while a modal surface covers the feed. */
  playbackSuspended?: boolean;
  muted: boolean;
  setMuted: (muted: boolean) => void;
  liked: BooleanMap;
  saved: BooleanMap;
  following: BooleanMap;
  loading: boolean;
  clipSource: ClipSource;
  feedError: string | null;
  /** Main-feed pull-to-refresh. Scoped collection feeds intentionally omit it. */
  onRefresh?: () => void;
  refreshing?: boolean;
  onLike: (clipId: string) => void;
  onSave: (clipId: string) => void;
  onToggleFollow: (personId: string) => void;
  onOpenPerson: (personId: string) => void;
  /** Replaces the `För dig` / `Senaste` tabs — used by a scoped collection. */
  header?: ReactNode;
  /** Clip to open on, when the viewer tapped a specific one in a grid. */
  initialClipId?: string | null;
  emptyMessage?: string;
}) {
  const [activeId, setActiveId] = useState(initialClipId ?? clips[0]?.id ?? "");
  const [paused, setPaused] = useState<BooleanMap>({});
  /**
   * FE-5. Autoplay blocked by browser policy is not a user pause. Conflating
   * them would record "browser refused to start unmuted audio" as a negative
   * preference signal, which is the opposite of what happened. Kept separate
   * from `paused` so the two can never be read as the same thing.
   */
  const [blocked, setBlocked] = useState<BooleanMap>({});
  const [playbackFlash, setPlaybackFlash] = useState<PlaybackFlash | null>(null);
  const [shareFeedback, setShareFeedback] = useState<ShareFeedback | null>(null);
  const [commentClip, setCommentClip] = useState<ClipItem | null>(null);
  const [predictedDirection, setPredictedDirection] = useState<1 | -1>(1);
  const [playableGeneration, setPlayableGeneration] = useState<string | null>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [pulling, setPulling] = useState(false);
  const secondLookaheadAllowed = useSecondLookahead();
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const pullStartY = useRef<number | null>(null);
  const pullDistanceRef = useRef(0);
  const wasRefreshingRef = useRef(false);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const videoRefCallbacks = useRef<
    Record<string, (node: HTMLVideoElement | null) => void>
  >({});
  const flashTimer = useRef<number | null>(null);
  const shareFeedbackTimer = useRef<number | null>(null);
  const resumeAfterComments = useRef(false);
  const resumeAfterVisibility = useRef(false);
  const playbackGeneration = useRef(0);
  const playbackMounted = useRef(false);
  const playbackSuspendedRef = useRef(playbackSuspended);
  const activeIdRef = useRef(activeId);
  const commentClipRef = useRef(commentClip);
  activeIdRef.current = activeId;
  playbackSuspendedRef.current = playbackSuspended;
  commentClipRef.current = commentClip;
  /**
   * FE-3. Loop boundaries per clip. A completion is the first `ended`; every
   * later one is a deliberate replay of a clip the viewer chose not to scroll
   * past. F2 reads this when the event stream exists; keeping the count now
   * means the distinction is observable from the day telemetry is switched on.
   */
  const loopCounts = useRef<Record<string, number>>({});
  /**
   * True when the mute is ours, not the viewer's — set when autoplay policy
   * forced a muted fallback. Two things depend on knowing the difference: the
   * next tap may undo our mute, and it must never undo theirs.
   */
  const autoMutedRef = useRef(false);

  useEffect(() => {
    // A collection opened from a grid starts on the clip that was tapped, not
    // at the top; falling back to the first clip if that id is not in the set.
    const wanted = initialClipId && clips.some((clip) => clip.id === initialClipId)
      ? initialClipId
      : clips[0]?.id ?? "";
    setActiveId(wanted);
    setPaused({});
    setBlocked({});
    setPlaybackFlash(null);
    setShareFeedback(null);
    setPredictedDirection(1);
    setPlayableGeneration(null);
    loopCounts.current = {};
  }, [clips, initialClipId]);

  useEffect(() => {
    const scroll = feedScrollRef.current;
    if (!scroll || !onRefresh) return;
    const resetPull = () => {
      pullStartY.current = null;
      pullDistanceRef.current = 0;
      setPulling(false);
      setPullDistance(0);
    };
    const handleTouchStart = (event: TouchEvent) => {
      if (loading || event.touches.length !== 1 || scroll.scrollTop > 1) {
        resetPull();
        return;
      }
      pullStartY.current = event.touches[0].clientY;
      setPulling(true);
    };
    const handleTouchMove = (event: TouchEvent) => {
      const startY = pullStartY.current;
      if (startY === null || event.touches.length !== 1 || scroll.scrollTop > 1) return;
      const downwardDistance = event.touches[0].clientY - startY;
      if (downwardDistance <= 0) {
        pullDistanceRef.current = 0;
        setPullDistance(0);
        return;
      }
      // Once the first feed item is already at the top, the downward gesture
      // belongs to Pleni's refresh affordance rather than the browser chrome.
      event.preventDefault();
      const dampedDistance = Math.min(88, downwardDistance * 0.7);
      pullDistanceRef.current = dampedDistance;
      setPullDistance(dampedDistance);
    };
    const handleTouchEnd = () => {
      const shouldRefresh = pullDistanceRef.current >= PULL_REFRESH_TRIGGER && !loading;
      pullStartY.current = null;
      pullDistanceRef.current = 0;
      setPulling(false);
      if (shouldRefresh) {
        setPullDistance(44);
        onRefresh();
      } else {
        setPullDistance(0);
      }
    };

    scroll.addEventListener("touchstart", handleTouchStart, { passive: true });
    scroll.addEventListener("touchmove", handleTouchMove, { passive: false });
    scroll.addEventListener("touchend", handleTouchEnd, { passive: true });
    scroll.addEventListener("touchcancel", resetPull, { passive: true });
    return () => {
      scroll.removeEventListener("touchstart", handleTouchStart);
      scroll.removeEventListener("touchmove", handleTouchMove);
      scroll.removeEventListener("touchend", handleTouchEnd);
      scroll.removeEventListener("touchcancel", resetPull);
    };
  }, [loading, onRefresh]);

  useEffect(() => {
    if (refreshing && !wasRefreshingRef.current && pullDistance === 0) {
      // A Home-button refresh can begin from any clip. Let the existing slate
      // glide to its first item while the replacement is fetched.
      feedScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
    if (!refreshing && wasRefreshingRef.current) {
      feedScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
      setPullDistance(0);
    }
    wasRefreshingRef.current = refreshing;
  }, [pullDistance, refreshing]);

  // Scroll the opening clip into view once, so the feed does not start at the
  // top and then jump.
  useEffect(() => {
    if (!initialClipId) {
      return;
    }
    const node = document.querySelector(`article[data-clip-id="${CSS.escape(initialClipId)}"]`);
    node?.scrollIntoView({ block: "start" });
  }, [initialClipId, clips]);

  /**
   * Autoplay policy refuses an unmuted `play()` until the origin has earned a
   * user gesture, so a feed that opens unmuted opens frozen — which is what a
   * short-form feed must never do. Fall back to muted, which policy does not
   * refuse, instead of treating the refusal as the end of the attempt.
   *
   * This sharpens FE-5 rather than weakening it. `blocked` stops meaning "audio
   * was refused", which is routine and happens on nearly every cold load, and
   * starts meaning "playback itself was refused", which is rare and is the only
   * case where a centre play button is the right answer.
   */
  const pauseAllPlayback = () => {
    playbackGeneration.current += 1;
    Object.values(videoRefs.current).forEach((video) => video?.pause());
  };

  const videoRefFor = (clipId: string) => {
    if (!videoRefCallbacks.current[clipId]) {
      const keepPlaybackInline = (event: Event) => {
        // Older WebKit-based browsers can still promote a video despite the
        // standard `playsinline` attribute. This event is not universal, but
        // where it exists, immediately hand playback back to Pleni's feed.
        event.preventDefault();
        const video = event.currentTarget as HTMLVideoElement & {
          webkitDisplayingFullscreen?: boolean;
          webkitExitFullscreen?: () => void;
        };
        if (video.webkitDisplayingFullscreen) {
          video.webkitExitFullscreen?.();
        }
      };

      videoRefCallbacks.current[clipId] = (node) => {
        const previous = videoRefs.current[clipId];
        if (previous && previous !== node) {
          // Ref cleanup is synchronous with DOM removal. It is the last line of
          // defence against detached media continuing to emit audio while
          // another app screen is visible.
          playbackGeneration.current += 1;
          previous.pause();
          previous.removeEventListener("webkitbeginfullscreen", keepPlaybackInline);
          if (videoRefs.current[clipId] === previous) {
            delete videoRefs.current[clipId];
          }
        }
        if (node && previous !== node) {
          // `playsInline` covers modern Chrome/Safari. Samsung Internet and some
          // Android WebViews still inspect one of these vendor attributes before
          // deciding whether to hand the MP4 to their native video assistant.
          node.controls = false;
          node.disablePictureInPicture = true;
          node.setAttribute("playsinline", "");
          node.setAttribute("webkit-playsinline", "");
          node.setAttribute("x5-playsinline", "");
          node.setAttribute("x5-video-player-type", "h5-page");
          node.setAttribute("x-webkit-airplay", "deny");
          node.addEventListener("webkitbeginfullscreen", keepPlaybackInline);
        }
        if (node) {
          videoRefs.current[clipId] = node;
        } else {
          delete videoRefs.current[clipId];
        }
      };
    }
    return videoRefCallbacks.current[clipId];
  };

  const playWithMutedFallback = (clipId: string, video: HTMLVideoElement) => {
    if (
      !playbackMounted.current ||
      playbackSuspendedRef.current ||
      document.visibilityState !== "visible" ||
      videoRefs.current[clipId] !== video ||
      !video.isConnected ||
      activeIdRef.current !== clipId
    ) {
      return;
    }

    const generation = ++playbackGeneration.current;
    const isCurrentRequest = () =>
      playbackMounted.current &&
      !playbackSuspendedRef.current &&
      playbackGeneration.current === generation &&
      document.visibilityState === "visible" &&
      videoRefs.current[clipId] === video &&
      video.isConnected &&
      activeIdRef.current === clipId;
    const succeeded = () => {
      if (!isCurrentRequest()) {
        return;
      }
      setPaused((state) => ({ ...state, [clipId]: false }));
      setBlocked((state) => ({ ...state, [clipId]: false }));
    };
    const refused = () => {
      if (!isCurrentRequest()) {
        return;
      }
      setPaused((state) => ({ ...state, [clipId]: true }));
      setBlocked((state) => ({ ...state, [clipId]: true }));
    };

    void video
      .play()
      .then(succeeded)
      .catch(() => {
        // `play()` settles asynchronously. The viewer may have switched to
        // Search/Profile, hidden the page or moved to another clip while the
        // browser was deciding whether unmuted autoplay is allowed. A stale
        // rejection must never start its muted fallback on a detached video.
        if (!isCurrentRequest()) {
          return;
        }
        if (video.muted) {
          // Already muted and still refused. That is a real block.
          refused();
          return;
        }
        video.muted = true;
        autoMutedRef.current = true;
        setMuted(true);
        void video.play().then(succeeded).catch(refused);
      });
  };

  /**
   * Media elements can keep playing after they have left the DOM, and a pending
   * `play()` promise can settle after React has already changed screens. Stop
   * them during layout cleanup (before detachment), invalidate every pending
   * fallback and do the same whenever the document becomes hidden.
   */
  useLayoutEffect(() => {
    playbackMounted.current = true;

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        const activeVideo = videoRefs.current[activeIdRef.current];
        resumeAfterVisibility.current =
          commentClipRef.current === null && activeVideo != null && !activeVideo.paused;
        pauseAllPlayback();
        return;
      }

      if (
        !resumeAfterVisibility.current ||
        playbackSuspendedRef.current ||
        commentClipRef.current !== null
      ) {
        return;
      }
      resumeAfterVisibility.current = false;
      const clipId = activeIdRef.current;
      const activeVideo = videoRefs.current[clipId];
      if (activeVideo) {
        playWithMutedFallback(clipId, activeVideo);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      playbackMounted.current = false;
      resumeAfterVisibility.current = false;
      pauseAllPlayback();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  /**
   * FE-3. Explicit loop rather than the `loop` attribute. The clip restarts
   * exactly as before; the difference is that the boundary is now a countable
   * event instead of an invisible seek to zero.
   */
  const handleClipEnded = (clipId: string, video: HTMLVideoElement) => {
    loopCounts.current[clipId] = (loopCounts.current[clipId] ?? 0) + 1;
    if (clipId !== activeId) {
      return;
    }
    video.currentTime = 0;
    playWithMutedFallback(clipId, video);
  };

  const openComments = (clip: ClipItem) => {
    const video = videoRefs.current[clip.id];
    resumeAfterComments.current = clip.id === activeId && video != null && !video.paused;
    pauseAllPlayback();
    setCommentClip(clip);
  };

  const closeComments = () => {
    const clipId = commentClip?.id;
    setCommentClip(null);
    if (!clipId || !resumeAfterComments.current || clipId !== activeId) {
      resumeAfterComments.current = false;
      return;
    }
    const video = videoRefs.current[clipId];
    resumeAfterComments.current = false;
    if (video) {
      playWithMutedFallback(clipId, video);
    }
  };

  useEffect(() => {
    if (!commentClip) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeComments();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    return () => {
      if (flashTimer.current !== null) {
        window.clearTimeout(flashTimer.current);
      }
      if (shareFeedbackTimer.current !== null) {
        window.clearTimeout(shareFeedbackTimer.current);
      }
    };
  }, []);

  /**
   * FE-4 (GATE). Activation used to be `if (entry.isIntersecting) setActiveId(...)`
   * at a single 0.72 threshold, which had two problems:
   *
   * 1. Every entry that crossed the threshold won, in callback order. A fast
   *    scroll past ten clips marked ten clips active — and once telemetry
   *    exists, that is ten impressions for a feed the viewer never saw.
   * 2. Two clips can exceed 0.72 during a slow drag, and the winner was
   *    whichever the browser reported last.
   *
   * Now: keep every ratio, pick the single highest above the visibility floor,
   * and only commit it after it has held the lead for a dwell period. Scrolling
   * straight past a clip never activates it.
   *
   * `IMPRESSION_VISIBLE_FRACTION` is the shared definition T-8 asks for — the
   * same number must drive both this activation and the analytics query, or the
   * metric has two definitions and therefore none.
   */
  useEffect(() => {
    const ratios = new Map<string, number>();
    let dwellTimer: number | null = null;
    let pendingWinner: string | null = null;

    const commitWinner = () => {
      let best: string | null = null;
      let bestRatio = IMPRESSION_VISIBLE_FRACTION;
      ratios.forEach((ratio, clipId) => {
        if (ratio >= bestRatio) {
          best = clipId;
          bestRatio = ratio;
        }
      });

      if (best === null || best === pendingWinner) {
        return;
      }
      pendingWinner = best;

      if (dwellTimer !== null) {
        window.clearTimeout(dwellTimer);
      }
      dwellTimer = window.setTimeout(() => {
        dwellTimer = null;
        if (pendingWinner !== null) {
          const previousIndex = clips.findIndex((clip) => clip.id === activeIdRef.current);
          const nextIndex = clips.findIndex((clip) => clip.id === pendingWinner);
          if (previousIndex >= 0 && nextIndex >= 0 && previousIndex !== nextIndex) {
            setPredictedDirection(nextIndex > previousIndex ? 1 : -1);
          }
          setActiveId(pendingWinner);
        }
      }, ACTIVATION_DWELL_MS);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const clipId = (entry.target as HTMLElement).dataset.clipId;
          if (clipId) {
            ratios.set(clipId, entry.intersectionRatio);
          }
        });
        commitWinner();
      },
      // Several thresholds so the ratio map stays current through a scroll
      // rather than only updating as one boundary is crossed.
      { threshold: [0, 0.25, 0.5, IMPRESSION_VISIBLE_FRACTION, 0.9, 1] }
    );

    document.querySelectorAll<HTMLElement>("[data-clip-id]").forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      if (dwellTimer !== null) {
        window.clearTimeout(dwellTimer);
      }
    };
  }, [clips]);

  useEffect(() => {
    pauseAllPlayback();
    if (
      playbackSuspended ||
      document.visibilityState !== "visible" ||
      commentClipRef.current !== null
    ) {
      return;
    }
    Object.entries(videoRefs.current).forEach(([clipId, video]) => {
      if (!video) {
        return;
      }
      video.muted = muted;
      if (clipId === activeId) {
        playWithMutedFallback(clipId, video);
      } else {
        video.pause();
      }
    });
    return pauseAllPlayback;
  }, [activeId, clips, playbackSuspended]);

  useEffect(() => {
    Object.values(videoRefs.current).forEach((video) => {
      if (video) {
        video.muted = muted;
      }
    });
  }, [muted]);

  const flashPlayback = (clipId: string, icon: PlaybackFlash["icon"]) => {
    if (flashTimer.current !== null) {
      window.clearTimeout(flashTimer.current);
      flashTimer.current = null;
    }
    setPlaybackFlash({ clipId, icon, nonce: Date.now() });
    flashTimer.current = window.setTimeout(() => {
      setPlaybackFlash((current) => (current?.clipId === clipId ? null : current));
    }, 520);
  };

  const shareFromRail = (clip: ClipItem) => {
    void shareClip(clip).then((outcome) => {
      if (outcome === "cancelled" || !playbackMounted.current) {
        return;
      }
      if (shareFeedbackTimer.current !== null) {
        window.clearTimeout(shareFeedbackTimer.current);
      }
      const feedback: ShareFeedback = {
        clipId: clip.id,
        kind: outcome,
        nonce: Date.now()
      };
      setShareFeedback(feedback);
      shareFeedbackTimer.current = window.setTimeout(() => {
        setShareFeedback((current) => (current?.nonce === feedback.nonce ? null : current));
      }, 2200);
    });
  };

  const toggleClipPlayback = (clipId: string) => {
    const video = videoRefs.current[clipId];
    if (!video || clipId !== activeId) {
      return;
    }
    // The tap that follows an automatic mute is the gesture that unlocks audio.
    // On a feed like this it means "let me hear it" far more often than "stop",
    // so spend it on turning sound on. Only ever undoes a mute we applied — an
    // explicit mute from the control below is the viewer's and stays put.
    if (autoMutedRef.current && !video.paused) {
      autoMutedRef.current = false;
      setMuted(false);
      return;
    }
    if (video.paused) {
      video.muted = muted;
      video
        .play()
        .then(() => {
          setPaused((state) => ({ ...state, [clipId]: false }));
          flashPlayback(clipId, "play");
        })
        .catch(() => {
          setPaused((state) => ({ ...state, [clipId]: true }));
          flashPlayback(clipId, "play");
        });
    } else {
      video.pause();
      setPaused((state) => ({ ...state, [clipId]: true }));
      flashPlayback(clipId, "pause");
    }
  };

  const seekClip = (clipId: string, seconds: number) => {
    const video = videoRefs.current[clipId];
    if (!video) {
      return null;
    }
    const fallbackDuration = clips.find((clip) => clip.id === clipId)?.durationS ?? 0;
    const duration =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : fallbackDuration;
    const nextTime = Math.min(Math.max(seconds, 0), duration);
    video.currentTime = nextTime;
    return nextTime;
  };

  // The source scheduler follows the last committed movement direction. It
  // keeps one clip behind, then stages the immediate and second destination.
  const activeIndex = clips.findIndex((clip) => clip.id === activeId);
  const windowCentre = activeIndex >= 0 ? activeIndex : 0;
  const immediateCandidateIndex = windowCentre + predictedDirection;
  const immediateCandidateId = clips[immediateCandidateIndex]?.id ?? "";
  const mediaGeneration = `${activeId}:${predictedDirection}:${immediateCandidateId}`;
  const immediatePlayable = playableGeneration === mediaGeneration;
  const mediaWindow = planMediaWindow({
    activeIndex: windowCentre,
    itemCount: clips.length,
    direction: predictedDirection,
    immediatePlayable,
    allowSecondLookahead: secondLookaheadAllowed
  });
  const sourceIndices = new Set(mediaWindow.sourceIndices);
  const pullProgress = refreshing ? 1 : Math.min(1, pullDistance / PULL_REFRESH_TRIGGER);
  const pullOffset = Math.min(52, pullDistance * 0.72);

  useLayoutEffect(() => {
    if (mediaWindow.immediateIndex === null) {
      return;
    }
    const clipId = clips[mediaWindow.immediateIndex]?.id;
    const video = clipId ? videoRefs.current[clipId] : null;
    if (video && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      setPlayableGeneration(mediaGeneration);
    }
  }, [clips, immediatePlayable, mediaGeneration, mediaWindow.immediateIndex]);

  return (
    <section className="feed-screen">
      {onRefresh && (pullDistance > 0 || refreshing) && (
        <div
          className={refreshing ? "feed-refresh feed-refresh--loading" : "feed-refresh"}
          style={{
            opacity: pullProgress,
            transform: `translate3d(-50%, ${-10 + pullProgress * 10}px, 0) scale(${0.92 + pullProgress * 0.08})`
          }}
          role="status"
          aria-live="polite"
        >
          <RefreshCw
            size={16}
            aria-hidden="true"
            style={refreshing ? undefined : { transform: `rotate(${pullProgress * 180}deg)` }}
          />
          <span>
            {refreshing
              ? "Uppdaterar"
              : pullDistance >= PULL_REFRESH_TRIGGER
                ? "Släpp för att uppdatera"
                : "Dra ned för att uppdatera"}
          </span>
        </div>
      )}
      {header ?? (
        <div className="feed-tabs" role="tablist" aria-label="Flöde">
          <button className={feedMode === "fordig" ? "active" : ""} onClick={() => setFeedMode("fordig")}>
            För dig
          </button>
          <button className={feedMode === "senaste" ? "active" : ""} onClick={() => setFeedMode("senaste")}>
            Senaste
          </button>
        </div>
      )}

      {loading && clips.length === 0 && <FeedSkeleton />}
      {loading && clips.length > 0 && !refreshing && (
        <div className="loading-chip">Hämtar klipp</div>
      )}

      {clipSource === "sample" && <div className="loading-chip">Demodata</div>}

      {/* FE-12: an honest empty state. Demo clips must never quietly stand in
          for a failed or empty catalogue read. */}
      {!loading && clips.length === 0 && (
        <div className="feed-empty" role="status">
          <strong>{emptyMessage ?? "Inga klipp att visa"}</strong>
          <span>{feedError ? "Klippen kunde inte hämtas just nu." : "Kom tillbaka snart."}</span>
        </div>
      )}

      <div
        className={pulling ? "feed-scroll feed-scroll--pulling" : "feed-scroll"}
        ref={feedScrollRef}
        style={{ transform: `translate3d(0, ${pullOffset}px, 0)` }}
      >
        {clips.map((clip, index) => {
          const distanceFromActive = Math.abs(index - windowCentre);
          const withinPosterWindow = distanceFromActive <= POSTER_WINDOW;
          const mediaMounted = sourceIndices.has(index);
          const preload =
            index === mediaWindow.immediateIndex ||
            index === mediaWindow.stagedIndex ||
            clip.id === activeId
            ? "auto"
            : "metadata";
          const person = personForClip(clip);
          const isLiked = !!liked[clip.id];
          const isSaved = !!saved[clip.id];
          const isFollowing = person !== null && !!following[person.id];
          const flashIcon = playbackFlash?.clipId === clip.id ? playbackFlash.icon : null;
          const flashNonce = playbackFlash?.clipId === clip.id ? playbackFlash.nonce : null;
          return (
            <FeedItemRow
              key={clip.id}
              clip={clip}
              person={person}
              videoRef={videoRefFor(clip.id)}
              videoSrc={mediaMounted ? clip.videoUrl : undefined}
              posterSrc={withinPosterWindow ? clip.thumbUrl : undefined}
              preload={preload}
              mediaMounted={mediaMounted}
              muted={muted}
              active={clip.id === activeId}
              blocked={!!blocked[clip.id]}
              liked={isLiked}
              saved={isSaved}
              following={isFollowing}
              flashIcon={flashIcon}
              flashNonce={flashNonce}
              shareFeedback={shareFeedback?.clipId === clip.id ? shareFeedback : null}
              onTogglePlayback={() => toggleClipPlayback(clip.id)}
              onToggleMuted={() => {
                // Whatever the viewer chooses here is theirs, so the
                // tap-to-unmute shortcut must not second-guess it later.
                autoMutedRef.current = false;
                setMuted(!muted);
              }}
              onLike={() => onLike(clip.id)}
              onComments={() => openComments(clip)}
              onSave={() => onSave(clip.id)}
              onShare={() => shareFromRail(clip)}
              onOpenPerson={() => {
                if (person) {
                  onOpenPerson(person.id);
                }
              }}
              onToggleFollow={() => {
                if (person) {
                  onToggleFollow(person.id);
                }
              }}
              onEnded={(video) => handleClipEnded(clip.id, video)}
              onPlay={() => {
                setPaused((state) => ({ ...state, [clip.id]: false }));
                setBlocked((state) => ({ ...state, [clip.id]: false }));
              }}
              onPause={() => setPaused((state) => ({ ...state, [clip.id]: true }))}
              onPlayable={() => {
                const video = videoRefs.current[clip.id];
                if (
                  index === mediaWindow.immediateIndex &&
                  video !== undefined &&
                  video !== null &&
                  video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
                ) {
                  setPlayableGeneration(mediaGeneration);
                }
              }}
              onSeek={(seconds) => seekClip(clip.id, seconds)}
            />
          );
        })}
      </div>
      {commentClip && <CommentSheet clip={commentClip} onClose={closeComments} />}
    </section>
  );
}

/**
 * A feed scoped to one politician or to the saved archive.
 *
 * Deliberately a thin wrapper over `FeedScreen` rather than a second player.
 * Everything the feed has earned — the FE-4 dwell activation, the FE-3
 * explicit loop, FE-5's blocked-vs-paused split — applies here for free, and
 * cannot drift out of sync with the main feed.
 */
function CollectionScreen({
  collection,
  onBack,
  muted,
  setMuted,
  liked,
  saved,
  following,
  onLike,
  onSave,
  onToggleFollow,
  onOpenPerson
}: {
  collection: ClipCollection;
  onBack: () => void;
  muted: boolean;
  setMuted: (muted: boolean) => void;
  liked: BooleanMap;
  saved: BooleanMap;
  following: BooleanMap;
  onLike: (clipId: string) => void;
  onSave: (clipId: string) => void;
  onToggleFollow: (personId: string) => void;
  onOpenPerson: (personId: string) => void;
}) {
  return (
    <FeedScreen
      clips={collection.clips}
      feedMode="senaste"
      setFeedMode={() => undefined}
      muted={muted}
      setMuted={setMuted}
      liked={liked}
      saved={saved}
      following={following}
      loading={false}
      clipSource="supabase"
      feedError={null}
      onLike={onLike}
      onSave={onSave}
      onToggleFollow={onToggleFollow}
      onOpenPerson={onOpenPerson}
      initialClipId={collection.startId}
      emptyMessage="Inga klipp här ännu"
      header={
        <div className="collection-bar">
          <button onClick={onBack} aria-label="Tillbaka">
            <ChevronLeft size={22} />
          </button>
          <span className="collection-copy">
            <strong>{collection.title}</strong>
            <small>{collection.subtitle}</small>
          </span>
        </div>
      }
    />
  );
}

function PlaybackFlashIcon({ icon }: { icon: PlaybackFlash["icon"] }) {
  return (
    <div className="playback-flash" aria-hidden="true">
      {icon === "play" ? <Play size={38} fill="currentColor" /> : <Pause size={38} fill="currentColor" />}
    </div>
  );
}

function ActionRail({
  clip,
  liked,
  saved,
  onLike,
  onComments,
  onSave,
  onShare,
  shareFeedback
}: {
  clip: ClipItem;
  liked: boolean;
  saved: boolean;
  onLike: () => void;
  onComments: () => void;
  onSave: () => void;
  onShare: () => void;
  shareFeedback: ShareFeedback | null;
}) {
  const shareLabel =
    shareFeedback?.kind === "shared"
      ? "Delat"
      : shareFeedback?.kind === "copied"
        ? "Kopierad"
        : shareFeedback?.kind === "error"
          ? "Försök igen"
          : "Dela";
  const shareAriaLabel =
    shareFeedback?.kind === "shared"
      ? "Klippet delades. Dela igen."
      : shareFeedback?.kind === "copied"
        ? "Länken kopierades. Dela igen."
        : shareFeedback?.kind === "error"
          ? "Kunde inte dela klippet. Försök igen."
          : "Dela klippet";

  return (
    <div className="action-rail" onClick={(event) => event.stopPropagation()}>
      {/* FE-2: no counts until a real one exists. These used to render
          `1200 + index * 143` as if it were a measured figure. */}
      <ActionButton label="Gilla" active={liked} onClick={onLike}>
        <Heart size={21} fill={liked ? "currentColor" : "none"} />
      </ActionButton>
      {/* Icon only: no Swedish word for this fits the 54px rail, and there is
          no real count to put there. The accessible name still describes it. */}
      <ActionButton label="Kommentarer" hideLabel onClick={onComments}>
        <MessageCircle size={21} />
      </ActionButton>
      <ActionButton label="Spara" active={saved} onClick={onSave}>
        <Bookmark size={21} fill={saved ? "currentColor" : "none"} />
      </ActionButton>
      <ActionButton
        label={shareLabel}
        ariaLabel={shareAriaLabel}
        announce={shareFeedback !== null}
        announceKey={shareFeedback?.nonce}
        onClick={onShare}
      >
        <Share2 size={21} />
      </ActionButton>
    </div>
  );
}

function ActionButton({
  children,
  label,
  ariaLabel,
  active = false,
  hideLabel = false,
  announce = false,
  announceKey,
  onClick
}: {
  children: React.ReactNode;
  label: string;
  ariaLabel?: string;
  active?: boolean;
  /** Keep the accessible name, drop the visible caption. */
  hideLabel?: boolean;
  announce?: boolean;
  announceKey?: number;
  onClick?: () => void;
}) {
  return (
    <div className="action">
      <button
        className={active ? "active" : ""}
        onClick={onClick}
        aria-label={ariaLabel ?? label}
      >
        {children}
      </button>
      {!hideLabel && (
        <span key={announceKey} role={announce ? "status" : undefined} aria-atomic={announce || undefined}>
          {label}
        </span>
      )}
    </div>
  );
}

const EMPTY_COMMENT_THREAD: CommentThread = { count: 0, comments: [] };

const COMMENT_REPORT_OPTIONS: Array<{ reason: CommentReportReason; label: string }> = [
  { reason: "spam", label: "Spam" },
  { reason: "harassment", label: "Hot eller trakasserier" },
  { reason: "hate", label: "Hat mot en grupp" },
  { reason: "private_information", label: "Privat information" },
  { reason: "illegal", label: "Misstänkt olagligt" },
  { reason: "other", label: "Annat" }
];

function CommentSheet({ clip, onClose }: { clip: ClipItem; onClose: () => void }) {
  const viewer = useViewer();
  const [thread, setThread] = useState<CommentThread>(EMPTY_COMMENT_THREAD);
  const [loading, setLoading] = useState(true);
  const [profileReady, setProfileReady] = useState(!viewer.signedIn);
  const [commentUsername, setCommentUsername] = useState<string | null>(null);
  const [handleDraft, setHandleDraft] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [menuCommentId, setMenuCommentId] = useState<string | null>(null);
  const [reportCommentId, setReportCommentId] = useState<string | null>(null);
  const [busyCommentId, setBusyCommentId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setThread(EMPTY_COMMENT_THREAD);
    setLoading(true);
    setProfileReady(!viewer.signedIn);
    setCommentUsername(null);
    setError(null);
    setNotice(null);
    setMenuCommentId(null);
    setReportCommentId(null);

    const load = async () => {
      const accessToken = viewer.signedIn ? await viewer.getAccessToken() : null;
      const loadedThread = await loadVideoComments(clip.id, accessToken);
      let loadedUsername: string | null = null;
      if (accessToken) {
        try {
          loadedUsername = await loadMyCommentUsername(accessToken);
        } catch {
          // Reading comments stays available even if the optional profile read
          // fails. Posting will surface the authenticated error precisely.
        }
      }
      if (!active) {
        return;
      }
      setThread(loadedThread);
      setCommentUsername(loadedUsername);
      const suggestion = normalizeCommentUsername(viewer.suggestedUsername ?? "");
      setHandleDraft(
        loadedUsername ?? (COMMENT_USERNAME_PATTERN.test(suggestion) ? suggestion : "")
      );
      setProfileReady(true);
    };

    void load()
      .catch((loadError: unknown) => {
        if (active) {
          setError(commentErrorMessage(loadError));
          setProfileReady(true);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [clip.id, viewer.signedIn]);

  const submitComment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!viewer.signedIn) {
      viewer.requireSignIn();
      return;
    }

    const normalizedUsername = normalizeCommentUsername(handleDraft);
    if (!commentUsername && !COMMENT_USERNAME_PATTERN.test(normalizedUsername)) {
      setError("Använd 3–24 små bokstäver, siffror eller understreck.");
      return;
    }

    setPosting(true);
    try {
      const accessToken = await viewer.getAccessToken();
      if (!accessToken) {
        viewer.requireSignIn();
        return;
      }
      const comment = await createVideoComment(
        clip.id,
        body,
        commentUsername ? null : normalizedUsername,
        accessToken
      );
      setThread((current) => ({
        count: current.count + 1,
        comments: [comment, ...current.comments]
      }));
      setCommentUsername(comment.authorUsername);
      setHandleDraft(comment.authorUsername);
      setBody("");
      setNotice("Kommentaren är publicerad.");
    } catch (submitError: unknown) {
      setError(commentErrorMessage(submitError));
    } finally {
      setPosting(false);
    }
  };

  const removeComment = async (comment: VideoComment) => {
    setBusyCommentId(comment.id);
    setError(null);
    try {
      const accessToken = await viewer.getAccessToken();
      if (!accessToken) {
        viewer.requireSignIn();
        return;
      }
      await deleteVideoComment(comment.id, accessToken);
      setThread((current) => ({
        count: Math.max(0, current.count - 1),
        comments: current.comments.filter((item) => item.id !== comment.id)
      }));
      setNotice("Kommentaren är borttagen.");
      setMenuCommentId(null);
    } catch (deleteError: unknown) {
      setError(commentErrorMessage(deleteError));
    } finally {
      setBusyCommentId(null);
    }
  };

  const reportComment = async (commentId: string, reason: CommentReportReason) => {
    setBusyCommentId(commentId);
    setError(null);
    try {
      const accessToken = viewer.signedIn ? await viewer.getAccessToken() : null;
      await reportVideoComment(commentId, reason, accessToken);
      setNotice("Tack. Rapporten har skickats till granskning.");
      setReportCommentId(null);
      setMenuCommentId(null);
    } catch (reportError: unknown) {
      setError(commentErrorMessage(reportError));
    } finally {
      setBusyCommentId(null);
    }
  };

  const normalizedDraft = normalizeCommentUsername(handleDraft);
  const handleIsReady = commentUsername !== null || COMMENT_USERNAME_PATTERN.test(normalizedDraft);
  const canPost = body.trim().length > 0 && body.length <= COMMENT_MAX_LENGTH && handleIsReady;

  return (
    <div className="comment-backdrop" onClick={onClose}>
      <section
        className="comment-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="comment-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="comment-grabber" aria-hidden="true" />
        <header className="comment-header">
          <div>
            <h2 id="comment-sheet-title">Kommentarer</h2>
            <span>{thread.count === 1 ? "1 kommentar" : `${thread.count} kommentarer`}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Stäng kommentarer">
            <X size={21} />
          </button>
        </header>

        <div className="comment-stream" aria-live="polite">
          {loading && (
            <div className="comment-state">
              <LoaderCircle className="comment-spinner" size={24} />
              <span>Hämtar samtalet</span>
            </div>
          )}
          {!loading && thread.comments.length === 0 && (
            <div className="comment-state comment-state--empty">
              <MessageCircle size={28} />
              <strong>Starta samtalet</strong>
              <span>Var först med en kommentar om klippet.</span>
            </div>
          )}
          {thread.comments.map((comment, index) => (
            <article
              className="comment-row"
              key={comment.id}
              style={{ "--comment-index": Math.min(index, 8) } as React.CSSProperties}
            >
              <div className="comment-copy">
                <div className="comment-byline">
                  <strong>@{comment.authorUsername}</strong>
                  <time dateTime={comment.createdAt}>{relativeCommentTime(comment.createdAt)}</time>
                </div>
                <p>{comment.body}</p>
                {reportCommentId === comment.id && (
                  <div className="comment-report-panel">
                    <span>Varför rapporterar du?</span>
                    <div>
                      {COMMENT_REPORT_OPTIONS.map((option) => (
                        <button
                          type="button"
                          key={option.reason}
                          disabled={busyCommentId === comment.id}
                          onClick={() => void reportComment(comment.id, option.reason)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="comment-menu">
                <button
                  type="button"
                  aria-label={`Åtgärder för @${comment.authorUsername}`}
                  aria-expanded={menuCommentId === comment.id}
                  onClick={() => {
                    setReportCommentId(null);
                    setMenuCommentId((current) => (current === comment.id ? null : comment.id));
                  }}
                >
                  <MoreHorizontal size={19} />
                </button>
                {menuCommentId === comment.id && (
                  <div className="comment-menu-popover">
                    {comment.isOwn ? (
                      <button
                        type="button"
                        className="danger"
                        disabled={busyCommentId === comment.id}
                        onClick={() => void removeComment(comment)}
                      >
                        <Trash2 size={15} />
                        Ta bort
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setReportCommentId(comment.id);
                          setMenuCommentId(null);
                        }}
                      >
                        <Flag size={15} />
                        Rapportera
                      </button>
                    )}
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>

        <footer className="comment-composer">
          {(error || notice) && (
            <div className={error ? "comment-feedback error" : "comment-feedback"} role={error ? "alert" : "status"}>
              {error ?? notice}
            </div>
          )}
          {!viewer.signedIn ? (
            <button className="comment-sign-in" type="button" onClick={viewer.requireSignIn}>
              Logga in för att kommentera
            </button>
          ) : !profileReady ? (
            <div className="comment-profile-loading">Förbereder din kommentar…</div>
          ) : (
            <form onSubmit={(event) => void submitComment(event)}>
              {!commentUsername && (
                <label className="comment-handle-field">
                  <span>Välj offentligt användarnamn</span>
                  <div>
                    <b>@</b>
                    <input
                      value={handleDraft}
                      onChange={(event) => setHandleDraft(event.target.value)}
                      maxLength={24}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="användarnamn"
                    />
                  </div>
                </label>
              )}
              <div className="comment-input-row">
                <label>
                  <span className="sr-only">Skriv en kommentar</span>
                  <textarea
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    maxLength={COMMENT_MAX_LENGTH}
                    rows={1}
                    placeholder={commentUsername ? `Kommentera som @${commentUsername}` : "Skriv en kommentar"}
                  />
                </label>
                <button type="submit" disabled={!canPost || posting} aria-label="Publicera kommentar">
                  {posting ? <LoaderCircle className="comment-spinner" size={18} /> : <Send size={18} />}
                </button>
              </div>
              <div className="comment-composer-meta">
                <span>Kommentarer är offentliga · inga länkar</span>
                {body.length >= 400 && <b>{body.length}/{COMMENT_MAX_LENGTH}</b>}
              </div>
            </form>
          )}
        </footer>
      </section>
    </div>
  );
}

function relativeCommentTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) {
    return "nyss";
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days} d`;
  }
  return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short" }).format(timestamp);
}

function ClipMeta({
  clip,
  person,
  following,
  onOpenPerson,
  onToggleFollow
}: {
  clip: ClipItem;
  /** Null when the speaker has no `politician_id` — see `personForClip` (Q-2). */
  person: Politician | null;
  following: boolean;
  onOpenPerson: () => void;
  onToggleFollow: () => void;
}) {
  const party = PARTIES[clip.party];
  const displayName = cleanName(clip.speakerName) || person?.name || clip.speakerName;
  const speechType = clip.anforandetyp || person?.role || "";
  // Q-2: without a stable id there is nothing durable to hang a follow or a
  // profile on, so both controls are inert rather than keyed on a name.
  const identified = person !== null;
  return (
    <div className="clip-meta" onClick={(event) => event.stopPropagation()}>
      <div className="person-row">
        <button className="person-pill" onClick={onOpenPerson} disabled={!identified}>
          <Avatar
            name={displayName}
            party={clip.party}
            size="sm"
            imageUrl={person?.avatarUrl ?? clip.politicianAvatarUrl}
          />
          <span className="person-copy">
            <strong>{displayName}</strong>
            <span>
              <i style={{ background: party.color }} />
              {party.abbr !== "NONE" ? `${party.abbr} · ` : ""}
              {speechType}
            </span>
          </span>
        </button>
        <button
          className={following ? "follow-button following" : "follow-button"}
          aria-pressed={identified ? following : undefined}
          disabled={!identified}
          title={identified ? undefined : "Talaren saknar id hos Riksdagen och kan inte följas"}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFollow();
          }}
        >
          {following ? "Följer" : "Följ"}
        </button>
      </div>
      {clip.recommendationReason && (
        <div className="recommendation-reason" title="Varför visas klippet?">
          {clip.recommendationReason}
        </div>
      )}
      <div className="clip-title">{clip.title}</div>
      <div className="clip-subtitle">
        {clip.sourceTitle} · {formatDate(clip.debateDate)}
      </div>
      <a className="source-link" href={clip.sourceUrl} target="_blank" rel="noreferrer">
        Hela debatten
        <ArrowUpRight size={13} />
      </a>
    </div>
  );
}

function ProgressRow({
  currentTime,
  duration,
  onSeek
}: {
  currentTime: number;
  duration: number;
  onSeek: (seconds: number) => void;
}) {
  const safeDuration = Math.max(duration, 0);
  const percent = safeDuration > 0 ? Math.min(Math.max(currentTime / safeDuration, 0), 1) : 0;

  const seekFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (safeDuration <= 0) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    onSeek((x / rect.width) * safeDuration);
  };

  return (
    <div className="progress-row" onClick={(event) => event.stopPropagation()}>
      <span>{formatDuration(currentTime)}</span>
      <div
        className="progress-track"
        role="slider"
        aria-label="Klippets position"
        aria-valuemin={0}
        aria-valuemax={Math.round(safeDuration)}
        aria-valuenow={Math.round(currentTime)}
        onPointerDown={(event) => {
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          seekFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) {
            seekFromPointer(event);
          }
        }}
        onPointerUp={(event) => {
          event.stopPropagation();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
      >
        <i style={{ width: `${percent * 100}%` }} />
      </div>
      <span>{formatDuration(safeDuration)}</span>
    </div>
  );
}

/**
 * Who the viewer follows.
 *
 * Resolves the stored uuids against `public.politicians` rather than filtering
 * the loaded feed: someone you followed last week is almost certainly not in
 * today's 60 most recent clips, so the old feed-derived list showed an empty
 * Följer tab for follows that genuinely existed.
 */
function FollowingScreen({
  followedPoliticians,
  followedParties,
  onOpenPerson,
  onOpenParty,
  onTogglePerson,
  onToggleParty
}: {
  followedPoliticians: string[];
  followedParties: PartyCode[];
  onOpenPerson: (personId: string) => void;
  onOpenParty: (party: PartyCode) => void;
  onTogglePerson: (personId: string) => void;
  onToggleParty: (party: PartyCode) => void;
}) {
  const [people, setPeople] = useState<Politician[]>([]);
  const [loading, setLoading] = useState(false);
  const key = followedPoliticians.join(",");

  useEffect(() => {
    if (followedPoliticians.length === 0) {
      setPeople([]);
      return;
    }
    let active = true;
    setLoading(true);
    loadPoliticiansByIds(followedPoliticians)
      .then((rows) => active && setPeople(rows))
      .catch(() => active && setPeople([]))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // `key` rather than the array itself: a new array identity on every render
    // would refetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const empty = followedParties.length === 0 && followedPoliticians.length === 0;

  return (
    <section className="panel-screen">
      <Header
        title="Följer"
        subtitle={`${followedParties.length} partier · ${followedPoliticians.length} personer`}
      />
      <div className="panel-scroll">
        {empty && (
          <div className="panel-empty" role="status">
            <strong>Du följer ingen ännu</strong>
            <span>Följ en politiker från ett klipp eller via sök, så samlas de här.</span>
          </div>
        )}
        {followedParties.length > 0 && (
          <Group title="Partier">
            {followedParties.map((partyCode) => {
              const party = PARTIES[partyCode];
              return (
                <ListRow
                  key={partyCode}
                  avatar={<PartyAvatar party={partyCode} />}
                  title={party.name}
                  onClick={() => onOpenParty(partyCode)}
                  action={
                    <button
                      className="mini-button"
                      aria-label={`Avfölj ${party.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleParty(partyCode);
                      }}
                    >
                      Avfölj
                    </button>
                  }
                />
              );
            })}
          </Group>
        )}
        {followedPoliticians.length > 0 && (
          <Group title="Personer">
            {loading && people.length === 0 && <ListRow title="Hämtar…" />}
            {people.map((politician) => (
              <ListRow
                key={politician.id}
                avatar={
                  <Avatar
                    name={cleanName(politician.name) || politician.name}
                    party={politician.party}
                    size="md"
                    imageUrl={politician.avatarUrl}
                  />
                }
                title={cleanName(politician.name) || politician.name}
                subtitle={[PARTIES[politician.party].name, politician.role]
                  .filter(Boolean)
                  .join(" · ")}
                onClick={() => onOpenPerson(politician.id)}
                action={
                  <button
                    className="mini-button"
                    aria-label={`Avfölj ${cleanName(politician.name) || politician.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onTogglePerson(politician.id);
                    }}
                  >
                    Avfölj
                  </button>
                }
              />
            ))}
          </Group>
        )}
      </div>
    </section>
  );
}

/**
 * Find a politician and open their page.
 *
 * Searches `public.politicians` over the network rather than filtering the
 * loaded feed. The old version could only find the ~23 people who happened to
 * appear in the 60 most recent clips, out of 165 with published clips — so
 * searching for almost anyone returned nothing.
 */
function SearchScreen({
  query,
  setQuery,
  partyFilter,
  setPartyFilter,
  onOpenPerson,
  onOpenParty
}: {
  query: string;
  setQuery: (query: string) => void;
  partyFilter: PartyCode | null;
  setPartyFilter: (party: PartyCode | null) => void;
  onOpenPerson: (personId: string) => void;
  onOpenParty: (party: PartyCode) => void;
}) {
  const [results, setResults] = useState<Politician[]>([]);
  const [partyProfiles, setPartyProfiles] = useState<PartyProfile[]>([]);
  const [partyProfilesLoading, setPartyProfilesLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [resolvedSearchKey, setResolvedSearchKey] = useState<string | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const normalizedQuery = query.trim();
  const showResults = normalizedQuery.length > 0 || partyFilter !== null;
  const searchKey = `${partyFilter ?? "ALL"}:${normalizedQuery.toLocaleLowerCase("sv-SE")}`;

  const rememberSearch = (value: string) => {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      return;
    }
    setRecentSearches((current) => {
      const next = [
        normalizedValue,
        ...current.filter(
          (item) =>
            item.toLocaleLowerCase("sv-SE") !== normalizedValue.toLocaleLowerCase("sv-SE")
        )
      ].slice(0, MAX_RECENT_SEARCHES);
      return next;
    });
  };

  const clearRecentSearches = () => {
    setRecentSearches([]);
  };

  const openParty = (profile: PartyProfile) => {
    rememberSearch(profile.name);
    onOpenParty(profile.abbr);
  };

  const openPerson = (politician: Politician) => {
    rememberSearch(cleanName(politician.name) || politician.name);
    onOpenPerson(politician.id);
  };

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setPartyProfilesLoading(true);
    loadPartyProfiles(controller.signal)
      .then((profiles) => {
        if (active) {
          setPartyProfiles(profiles);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) {
          setPartyProfilesLoading(false);
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const matchingParties = useMemo(() => {
    if (partyFilter && partyFilter !== "NONE") {
      return partyProfiles.filter((profile) => profile.abbr === partyFilter);
    }
    const term = normalizedQuery.toLocaleLowerCase("sv-SE");
    if (!term) {
      return [];
    }
    return partyProfiles.filter((profile) =>
      [profile.abbr, profile.name, profile.short]
        .some((value) => value.toLocaleLowerCase("sv-SE").includes(term))
    );
  }, [normalizedQuery, partyFilter, partyProfiles]);

  const resultCount = matchingParties.length + results.length;
  const searchPending =
    showResults &&
    (partyProfilesLoading || searching || resolvedSearchKey !== searchKey);

  useEffect(() => {
    if (!showResults) {
      setResults([]);
      setSearching(false);
      setResolvedSearchKey(null);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    setResolvedSearchKey(null);
    // Debounced: a request per keystroke would put ~8 in flight for a surname
    // and the answers can arrive out of order.
    const timer = window.setTimeout(() => {
      searchPoliticians(normalizedQuery, { party: partyFilter, signal: controller.signal })
        .then((politicians) => {
          if (!controller.signal.aborted) {
            setResults(politicians);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setResults([]);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setResolvedSearchKey(searchKey);
            setSearching(false);
          }
        });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      // Abort in flight too, so a slow early response cannot overwrite a newer
      // one — the same stale-response rule FE-7 states for the feed.
      controller.abort();
    };
  }, [normalizedQuery, partyFilter, searchKey, showResults]);

  return (
    <section
      className={showResults ? "panel-screen search-screen has-results" : "panel-screen search-screen"}
    >
      <div className="search-header">
        {!showResults && <h1>Sök</h1>}
        <label className="search-box">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                rememberSearch(normalizedQuery);
              }
            }}
            aria-label="Sök person, parti eller ämne"
            placeholder="Sök person, parti eller ämne"
          />
          {query.length > 0 && (
            <button type="button" onClick={() => setQuery("")} aria-label="Rensa sökningen">
              <X size={13} />
            </button>
          )}
        </label>
        <div className="chips" aria-label="Filtrera på parti">
          <button
            type="button"
            className={partyFilter === null ? "active" : ""}
            onClick={() => setPartyFilter(null)}
          >
            <i />
            Alla
          </button>
          {partyCodes.map((party) => (
            <button
              type="button"
              key={party}
              className={partyFilter === party ? "active" : ""}
              onClick={() => setPartyFilter(party)}
            >
              <i style={{ background: PARTIES[party].color }} />
              {party}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-scroll" aria-busy={searchPending || undefined}>
        {showResults ? (
          searchPending ? (
            <SearchResultsSkeleton />
          ) : resultCount === 0 ? (
            <div className="panel-empty" role="status">
              <strong>Inga träffar</strong>
              <span>Sök på en politikers namn, eller filtrera på parti.</span>
            </div>
          ) : (
            <div className="search-results" aria-live="polite">
              {matchingParties.length > 0 && (
                <section className="search-party-results" aria-label="Partier">
                  <div className="search-kicker">Partisida</div>
                  {matchingParties.map((profile) => (
                    <button
                      type="button"
                      className="search-party-card"
                      key={`party-${profile.abbr}`}
                      onClick={() => openParty(profile)}
                      style={{ "--party-color": profile.color } as React.CSSProperties}
                    >
                      <PartyAvatar party={profile.abbr} color={profile.color} />
                      <span className="search-party-copy">
                        <small>Riksdagsparti</small>
                        <strong>{profile.name}</strong>
                        {(profile.clipCount !== null || profile.politicianCount !== null) && (
                          <span>
                            {[
                              profile.clipCount !== null
                                ? `${formatNumber(profile.clipCount)} klipp`
                                : null,
                              profile.politicianCount !== null
                                ? `${formatNumber(profile.politicianCount)} politiker`
                                : null
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        )}
                      </span>
                      <span className="search-party-action" aria-hidden="true">
                        <ArrowUpRight size={17} />
                      </span>
                      <span className="search-party-footer">
                        <b>Öppna partisidan</b>
                        <span>Alla klipp från partiets politiker</span>
                      </span>
                    </button>
                  ))}
                </section>
              )}

              {results.length > 0 && (
                <section className="search-people-results" aria-label="Politiker">
                  <div className="search-result-heading">
                    <span>Politiker</span>
                    <b>
                      {results.length} {results.length === 1 ? "träff" : "träffar"}
                    </b>
                  </div>
                  <div className="search-result-list">
                    {results.map((politician) => (
                      <ListRow
                        key={politician.id}
                        avatar={
                          <Avatar
                            name={cleanName(politician.name) || politician.name}
                            party={politician.party}
                            size="md"
                            imageUrl={politician.avatarUrl}
                          />
                        }
                        title={cleanName(politician.name) || politician.name}
                        subtitle={[PARTIES[politician.party].name, politician.role]
                          .filter(Boolean)
                          .join(" · ")}
                        onClick={() => openPerson(politician)}
                        chevron
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )
        ) : (
          <>
            {recentSearches.length > 0 && (
              <section className="recent-block">
                <div className="section-label">
                  <span>Senaste sökningar</span>
                  <button type="button" onClick={clearRecentSearches}>
                    Rensa
                  </button>
                </div>
                <div className="recent-chips">
                  {recentSearches.map((item) => (
                    <button
                      type="button"
                      key={item}
                      onClick={() => {
                        setPartyFilter(null);
                        setQuery(item);
                      }}
                    >
                      <Clock3 size={12} />
                      {item}
                    </button>
                  ))}
                </div>
              </section>
            )}
            <Group title="Populära debatter">
              <div className="placeholder-note">
                Exempeldata — populäritet mäts inte ännu.
              </div>
              {TRENDING.map((item) => (
                <ListRow
                  key={item.n}
                  eyebrow={item.n}
                  title={item.title}
                  subtitle={item.meta}
                  action={<span className="up">{item.up}</span>}
                />
              ))}
            </Group>
          </>
        )}
      </div>
    </section>
  );
}

function LegalScreen({
  page,
  onBack,
  onNavigate
}: {
  page: LegalPageId;
  onBack: () => void;
  onNavigate: (page: LegalPageId) => void;
}) {
  const document = LEGAL_PAGES[page];
  return (
    <section className="panel-screen legal-screen">
      <header className="legal-topbar">
        <button type="button" aria-label="Tillbaka till Profil" onClick={onBack}>
          <ChevronLeft size={20} />
        </button>
        <span>Juridisk information</span>
      </header>
      <div className="legal-scroll">
        <header className="legal-intro">
          <span className="legal-kicker">Pleni</span>
          <h1>{document.title}</h1>
          <p>{document.summary}</p>
          <time dateTime={LEGAL_VERSION}>Gäller från 14 augusti 2026 · version {LEGAL_VERSION}</time>
        </header>

        <div className="legal-document">
          {document.sections.map((section) => (
            <section key={section.title} className="legal-section">
              <h2>{section.title}</h2>
              {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              {section.bullets && (
                <ul>
                  {section.bullets.map((item) => <li key={item}>{item}</li>)}
                </ul>
              )}
              {section.links && (
                <div className="legal-source-links">
                  {section.links.map((link) => {
                    const external = link.href.startsWith("http");
                    return (
                      <a
                        key={link.href}
                        href={link.href}
                        target={external ? "_blank" : undefined}
                        rel={external ? "noreferrer" : undefined}
                      >
                        {link.label}
                        {external && <ArrowUpRight size={13} />}
                      </a>
                    );
                  })}
                </div>
              )}
            </section>
          ))}
        </div>

        <nav className="legal-related" aria-label="Fler juridiska sidor">
          <span>Mer information</span>
          <div>
            {LEGAL_PAGE_ORDER.map((relatedPage) => (
              <button
                key={relatedPage}
                type="button"
                className={relatedPage === page ? "is-current" : undefined}
                aria-current={relatedPage === page ? "page" : undefined}
                onClick={() => onNavigate(relatedPage)}
              >
                {LEGAL_PAGES[relatedPage].shortTitle}
              </button>
            ))}
          </div>
        </nav>
      </div>
    </section>
  );
}

function ProfileScreen({
  consent,
  selectedParties,
  savedCount,
  followedCount,
  followedPartyCount,
  savedLoading,
  onOpenSaved,
  onOpenFollowing,
  onEditInterests,
  onToggleConsent,
  onOpenLegal,
  pwa,
  recommendationsConnected,
  recommendationError,
  recommendationAction,
  recommendationActionMessage,
  onExportRecommendationData,
  onResetRecommendationData,
  onDeleteRecommendationData
}: {
  consent: { personal: boolean; analytics: boolean; email: boolean };
  selectedParties: number;
  savedCount: number;
  followedCount: number;
  followedPartyCount: number;
  savedLoading: boolean;
  onOpenSaved: () => void;
  onOpenFollowing: () => void;
  onEditInterests: () => void;
  onToggleConsent: (key: keyof typeof consent) => void;
  onOpenLegal: (page: LegalPageId) => void;
  pwa: PwaExperience;
  recommendationsConnected: boolean;
  recommendationError: string | null;
  recommendationAction: "export" | "reset" | "delete" | null;
  recommendationActionMessage: string | null;
  onExportRecommendationData: () => void;
  onResetRecommendationData: () => void;
  onDeleteRecommendationData: () => void;
}) {
  const totalFollowed = followedCount + followedPartyCount;
  const followedSummary = [
    followedCount > 0
      ? `${followedCount} ${followedCount === 1 ? "person" : "personer"}`
      : null,
    followedPartyCount > 0
      ? `${followedPartyCount} ${followedPartyCount === 1 ? "parti" : "partier"}`
      : null
  ]
    .filter(Boolean)
    .join(" · ");
  const consentRows = [
    {
      key: "personal" as const,
      title: "Personaliserat flöde",
      help: consent.personal
        ? "Använder partier och politiker du själv väljer. Tittarhistorik används inte i denna version."
        : recommendationsConnected
          ? "Avstängt. Dina lokala val används inte av För dig förrän du slår på personalisering."
        : "Sparar dina val på enheten. Tittarhistorik skickas inte till Pleni."
    }
  ];
  return (
    <section className="panel-screen">
      <Header title="Profil" />
      <div className="panel-scroll">
        <AccountCard onOpenLegal={onOpenLegal} />
        {/* These counts used to be invented ("Sparade klipp 24"). They are now
            the real length of the device-local library — see
            `library-store.ts`. Still not server-side: that is `C-9`, gated on
            F1. */}
        <Group title="Konto">
          <ListRow
            title="Sparade klipp"
            subtitle={
              savedCount === 0
                ? "Inga sparade klipp ännu"
                : `${savedCount} ${savedCount === 1 ? "klipp" : "klipp"} · sparas på den här enheten`
            }
            icon={<Bookmark size={18} />}
            onClick={savedCount > 0 && !savedLoading ? onOpenSaved : undefined}
            chevron={savedCount > 0}
          />
          <ListRow
            title="Följer"
            subtitle={
              totalFollowed === 0
                ? "Du följer ingen ännu"
                : `${followedSummary} · används i För dig när personalisering är på`
            }
            icon={<UserPlus size={18} />}
            onClick={onOpenFollowing}
            chevron
          />
        </Group>
        {pwa.installKind && (
          <Group title="App">
            <ListRow
              title={pwa.installBusy ? "Väntar på ditt val…" : "Installera Pleni"}
              subtitle={
                pwa.installKind === "ios"
                  ? "Lägg till på hemskärmen från Dela-menyn."
                  : pwa.installKind === "manual"
                    ? "Installera via webbläsarens meny."
                    : "Öppna Pleni utan webbläsarens adressfält."
              }
              icon={
                pwa.installBusy ? (
                  <LoaderCircle className="pwa-spinner" size={18} aria-hidden="true" />
                ) : (
                  <Download size={18} aria-hidden="true" />
                )
              }
              onClick={pwa.installBusy ? undefined : () => void pwa.requestInstall()}
              chevron={!pwa.installBusy}
            />
            {pwa.showInstallInstructions && (
              <div className="pwa-install-guide">
                <button
                  type="button"
                  className="pwa-install-guide-close"
                  aria-label="Stäng installationsguiden"
                  onClick={pwa.dismissInstallInstructions}
                >
                  <X size={16} aria-hidden="true" />
                </button>
                {pwa.installKind === "ios" ? (
                  <div role="status" aria-atomic="true">
                    <div className="pwa-install-guide-heading">
                      <Share2 size={18} aria-hidden="true" />
                      <strong>Lägg till på hemskärmen</strong>
                    </div>
                    <ol>
                      <li>Tryck på Dela-symbolen i Safari.</li>
                      <li>
                        Välj <b>Lägg till på hemskärmen</b>.
                      </li>
                      <li>
                        Bekräfta med <b>Lägg till</b>.
                      </li>
                    </ol>
                  </div>
                ) : (
                  <div role="status" aria-atomic="true">
                    <div className="pwa-install-guide-heading">
                      <Download size={18} aria-hidden="true" />
                      <strong>Installera via webbläsaren</strong>
                    </div>
                    <ol>
                      <li>Öppna webbläsarens meny.</li>
                      <li>
                        Välj <b>Installera app</b> eller <b>Lägg till på startskärmen</b>.
                      </li>
                      <li>Bekräfta installationen.</li>
                    </ol>
                  </div>
                )}
              </div>
            )}
          </Group>
        )}
        <Group title="Mina intressen">
          <ListRow
            title="Redigera mina intressen"
            subtitle={
              selectedParties > 0
                ? `${selectedParties} partier valda${consent.personal ? " · kopplade till För dig" : " · sparas på enheten"}`
                : "Inga partier valda ännu"
            }
            icon={<Sliders size={18} />}
            onClick={onEditInterests}
            chevron
          />
        </Group>
        <Group title="Personalisering">
          {consentRows.map((row) => (
            <ListRow
              key={row.key}
              title={row.title}
              subtitle={row.help}
              action={
                <Switch
                  checked={consent[row.key]}
                  onChange={() => onToggleConsent(row.key)}
                />
              }
            />
          ))}
          {recommendationError && (
            <div className="recommendation-error" role="alert">
              {recommendationError}
            </div>
          )}
        </Group>
        {recommendationsConnected && (
          <Group title="Mina rekommendationsdata">
            <ListRow
              title={recommendationAction === "export" ? "Skapar export…" : "Hämta mina data"}
              subtitle="Ladda ner samtycke, val och rekommendationslistor som JSON."
              icon={
                recommendationAction === "export" ? (
                  <LoaderCircle className="pwa-spinner" size={18} aria-hidden="true" />
                ) : (
                  <Download size={18} />
                )
              }
              onClick={recommendationAction ? undefined : onExportRecommendationData}
              chevron={!recommendationAction}
            />
            <ListRow
              title={recommendationAction === "reset" ? "Återställer…" : "Återställ rekommendationer"}
              subtitle="Stänger av personalisering och raderar serverns val och tidigare listor."
              icon={
                recommendationAction === "reset" ? (
                  <LoaderCircle className="pwa-spinner" size={18} aria-hidden="true" />
                ) : (
                  <RefreshCw size={18} />
                )
              }
              onClick={recommendationAction ? undefined : onResetRecommendationData}
              chevron={!recommendationAction}
            />
            <ListRow
              title={recommendationAction === "delete" ? "Raderar…" : "Radera rekommendationsdata"}
              subtitle="Raderar rekommendationsprofilen utan att radera ditt Clerk-konto."
              icon={
                recommendationAction === "delete" ? (
                  <LoaderCircle className="pwa-spinner" size={18} aria-hidden="true" />
                ) : (
                  <Trash2 size={18} />
                )
              }
              onClick={recommendationAction ? undefined : onDeleteRecommendationData}
              chevron={!recommendationAction}
            />
            {recommendationActionMessage && (
              <div className="recommendation-success" role="status">
                {recommendationActionMessage}
              </div>
            )}
          </Group>
        )}
        <nav className="profile-legal-links" aria-label="Juridisk information">
          {LEGAL_PAGE_ORDER.map((page) => (
            <button key={page} type="button" onClick={() => onOpenLegal(page)}>
              {LEGAL_PAGES[page].shortTitle}
            </button>
          ))}
        </nav>
        <div className="version">Pleni 1.0 · data från riksdagen.se</div>
      </div>
    </section>
  );
}

/**
 * Identity block at the top of the Profil tab.
 *
 * Three states: Clerk not configured, signed out, signed in. The anonymous
 * `Senaste` feed works in all three — signing in is never required to watch.
 */
function AccountCard({ onOpenLegal }: { onOpenLegal: (page: LegalPageId) => void }) {
  if (!clerkEnabled) {
    return (
      <div className="account-card account-card--muted">
        <div className="account-copy">
          <strong>Inloggning är inte konfigurerad</strong>
          <span>Sätt VITE_CLERK_PUBLISHABLE_KEY för att aktivera konton.</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <Show when="signed-out">
        <div className="account-card">
          <div className="account-copy">
            <strong>Logga in för ditt flöde</strong>
            <span>Senaste fungerar utan konto. Med konto kan du spara klipp och följa politiker.</span>
          </div>
          <div className="account-actions">
            <SignInButton mode="modal">
              <button className="account-button account-button--primary">Logga in</button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button className="account-button">Skapa konto</button>
            </SignUpButton>
          </div>
          <p className="account-legal-copy">
            Genom att skapa konto godkänner du{" "}
            <button type="button" onClick={() => onOpenLegal("terms")}>
              användarvillkoren
            </button>
            . Läs hur vi hanterar personuppgifter under{" "}
            <button type="button" onClick={() => onOpenLegal("privacy")}>
              integritet
            </button>
            . Om du är under 13 år behöver du din vårdnadshavares tillstånd.
          </p>
        </div>
      </Show>
      <Show when="signed-in">
        <SignedInAccountCard />
      </Show>
    </>
  );
}

function SignedInAccountCard() {
  const { user } = useUser();
  const displayName = user?.fullName ?? user?.username ?? "Ditt konto";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";

  return (
    <div className="account-card">
      <UserButton
        appearance={{ elements: { userButtonAvatarBox: { width: 46, height: 46 } } }}
      />
      <div className="account-copy">
        <strong>{displayName}</strong>
        {email ? <span>{email}</span> : null}
      </div>
      <SignOutButton>
        <button className="mini-button">Logga ut</button>
      </SignOutButton>
    </div>
  );
}

/**
 * The saved archive is a chooser, not another autoplaying feed. It uses the
 * same thumbnail grid as politician and party pages; only after a viewer picks
 * a clip do we hand the list to the shared immersive player.
 */
function SavedScreen({
  clips,
  loading,
  error,
  onBack,
  onPlayClip
}: {
  clips: ClipItem[];
  loading: boolean;
  error: string | null;
  onBack: () => void;
  onPlayClip: (clipId: string) => void;
}) {
  return (
    <section className="person-screen saved-screen">
      <div className="person-topbar">
        <button onClick={onBack} aria-label="Tillbaka">
          <ChevronLeft size={24} />
        </button>
        <strong>Sparade klipp</strong>
        <span className="person-topbar-spacer" aria-hidden="true" />
      </div>
      <div className="panel-scroll person-scroll">
        <section className="clip-grid-block">
          <div className="section-label">
            {clips.length} {clips.length === 1 ? "sparat klipp" : "sparade klipp"}
          </div>
          {loading && clips.length === 0 && <ClipGridSkeleton />}
          {!loading && error && (
            <div className="panel-empty" role="status">
              <strong>{error}</strong>
              <span>Försök igen om en stund.</span>
            </div>
          )}
          {!loading && !error && clips.length === 0 && (
            <div className="panel-empty" role="status">
              <strong>Inga sparade klipp ännu</strong>
              <span>Spara ett klipp i flödet så hittar du det här.</span>
            </div>
          )}
          {clips.length > 0 && (
            <div className="clip-grid">
              {clips.map((clip) => (
                <button
                  className="mini-clip"
                  key={clip.id}
                  onClick={() => onPlayClip(clip.id)}
                  aria-label={`Spela: ${clip.title}`}
                >
                  <img src={clip.thumbUrl} alt="" loading="lazy" />
                  <span className="mini-clip-duration">{formatDuration(clip.durationS)}</span>
                  <span className="mini-clip-copy">
                    <b>{clip.title}</b>
                    <small>{formatDate(clip.debateDate)}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function PartyScreen({
  party,
  clips,
  politicians,
  loading,
  onBack,
  following,
  onToggleFollow,
  onPlayClip,
  onOpenPerson
}: {
  party: PartyProfile | null;
  clips: ClipItem[];
  politicians: Politician[];
  loading: boolean;
  onBack: () => void;
  following: boolean;
  onToggleFollow: () => void;
  onPlayClip: (clipId: string | null) => void;
  onOpenPerson: (personId: string) => void;
}) {
  return (
    <section className="party-screen">
      <div className="person-topbar">
        <button onClick={onBack} aria-label="Tillbaka">
          <ChevronLeft size={24} />
        </button>
        <strong>{party?.name ?? "Parti"}</strong>
        <button aria-label="Dela">
          <Share2 size={19} />
        </button>
      </div>
      <div className="panel-scroll person-scroll">
        {loading && !party && <ProfileSkeleton variant="party" />}
        {!loading && !party && (
          <div className="panel-empty" role="status">
            <strong>Partisidan kunde inte hämtas</strong>
            <span>Försök igen om en stund.</span>
          </div>
        )}
        {party && (
          <>
            <section
              className="party-hero"
              style={{ "--party-color": party.color } as React.CSSProperties}
            >
              <PartyAvatar party={party.abbr} color={party.color} size="xl" />
              <div className="party-identity">
                <span>Riksdagsparti · {party.abbr}</span>
                <h1>{party.name}</h1>
                <p>Senaste publicerade klippen från partiets politiker.</p>
              </div>
              <button
                className={following ? "follow-wide following" : "follow-wide"}
                onClick={onToggleFollow}
              >
                {following ? "Följer" : "Följ"}
              </button>
            </section>

            <div className="stats party-stats">
              {typeof party.clipCount === "number" && (
                <Stat label="Klipp" value={formatNumber(party.clipCount)} />
              )}
              {typeof party.politicianCount === "number" && (
                <Stat label="Politiker" value={formatNumber(party.politicianCount)} />
              )}
              <Stat label="Visas här" value={formatNumber(clips.length)} />
            </div>

            <section className="clip-grid-block">
              <div className="section-label">Senaste klipp</div>
              {loading && clips.length === 0 && <ClipGridSkeleton />}
              {!loading && clips.length === 0 && (
                <div className="panel-empty" role="status">
                  <strong>Inga publicerade klipp</strong>
                  <span>Partiets politiker har inga klipp i katalogen ännu.</span>
                </div>
              )}
              {clips.length > 0 && (
                <div className="clip-grid">
                  {clips.map((clip) => (
                    <button
                      className="mini-clip"
                      key={clip.id}
                      onClick={() => onPlayClip(clip.id)}
                      aria-label={`Spela: ${clip.title}`}
                    >
                      <img src={clip.thumbUrl} alt="" loading="lazy" />
                      <span className="mini-clip-duration">{formatDuration(clip.durationS)}</span>
                      <span className="mini-clip-copy">
                        <b>{clip.title}</b>
                        <small>{formatDate(clip.debateDate)}</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            {politicians.length > 0 && (
              <Group title="Politiker">
                {politicians.map((politician) => (
                  <ListRow
                    key={politician.id}
                    avatar={
                      <Avatar
                        name={cleanName(politician.name) || politician.name}
                        party={politician.party}
                        size="md"
                        imageUrl={politician.avatarUrl}
                      />
                    }
                    title={cleanName(politician.name) || politician.name}
                    subtitle={[politician.role, politician.constituency].filter(Boolean).join(" · ")}
                    onClick={() => onOpenPerson(politician.id)}
                    chevron
                  />
                ))}
              </Group>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function PersonScreen({
  person,
  clips,
  loading,
  onBack,
  following,
  onToggleFollow,
  onPlayClip
}: {
  person: Politician | null;
  clips: ClipItem[];
  loading: boolean;
  onBack: () => void;
  following: boolean;
  onToggleFollow: () => void;
  onPlayClip: (clipId: string | null) => void;
}) {
  const displayName = person ? cleanName(person.name) || person.name : "";
  const party = person ? PARTIES[person.party] : PARTIES.NONE;
  // The exact published total, which is not the same as how many were loaded
  // onto this page. Null means it could not be read — rendered as absent, not
  // as zero.
  const total = person?.clipCount;

  return (
    <section className="person-screen">
      <div className="person-topbar">
        <button onClick={onBack} aria-label="Tillbaka">
          <ChevronLeft size={24} />
        </button>
        <strong>{displayName}</strong>
        <button aria-label="Dela">
          <Share2 size={19} />
        </button>
      </div>
      <div className="panel-scroll person-scroll">
        {loading && !person && <ProfileSkeleton variant="person" />}
        {!loading && !person && (
          <div className="panel-empty" role="status">
            <strong>Profilen kunde inte hämtas</strong>
            <span>Försök igen om en stund.</span>
          </div>
        )}
        {person && (
          <>
            <section className="person-hero">
              <Avatar
                name={displayName}
                party={person.party}
                size="xl"
                imageUrl={person.avatarUrl}
              />
              {person.avatarUrl && <span className="portrait-credit">Foto: Sveriges riksdag</span>}
              <h1>{displayName}</h1>
              <span className="party-pill">
                <i style={{ background: party.color }} />
                {party.name}
              </span>
              {(person.role || person.constituency) && (
                <p>{[person.role, person.constituency].filter(Boolean).join(" · ")}</p>
              )}
              <button
                className={following ? "follow-wide following" : "follow-wide"}
                onClick={onToggleFollow}
              >
                {following ? "Följer" : "Följ"}
              </button>
            </section>

            {/* Real, counted numbers only. "Följare 16 800" used to sit here,
                taken from a hardcoded demo profile that real clips matched by
                name. Nothing counts followers, so the stat is gone rather than
                zeroed (FE-2). */}
            <div className="stats">
              {typeof total === "number" && <Stat label="Klipp" value={formatNumber(total)} />}
              <Stat label="Visas här" value={formatNumber(clips.length)} />
            </div>

            <section className="clip-grid-block">
              <div className="section-label">Klipp</div>
              {loading && clips.length === 0 && <ClipGridSkeleton />}
              {!loading && clips.length === 0 && (
                <div className="panel-empty" role="status">
                  <strong>Inga publicerade klipp</strong>
                  <span>Den här talaren har inga klipp i katalogen ännu.</span>
                </div>
              )}
              {clips.length > 0 && (
                <div className="clip-grid">
                  {clips.map((clip) => (
                    <button
                      className="mini-clip"
                      key={clip.id}
                      onClick={() => onPlayClip(clip.id)}
                      aria-label={`Spela: ${clip.title}`}
                    >
                      <img src={clip.thumbUrl} alt="" loading="lazy" />
                      <span className="mini-clip-duration">{formatDuration(clip.durationS)}</span>
                      <span className="mini-clip-copy">
                        <b>{clip.title}</b>
                        {/* Q-8: every clip shows its debate date, here as well
                            as in the feed. Target for "old content without a
                            visible date" is exactly zero. */}
                        <small>{formatDate(clip.debateDate)}</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </section>
  );
}

function FeedSkeleton() {
  return (
    <div className="feed-skeleton" role="status" aria-label="Hämtar klipp">
      <span className="sr-only">Hämtar klipp…</span>
      <div className="feed-skeleton-video" aria-hidden="true" />
      <div className="feed-skeleton-copy" aria-hidden="true">
        <span className="skeleton-shape" />
        <span className="skeleton-shape" />
        <span className="skeleton-shape" />
      </div>
      <div className="feed-skeleton-actions" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <span className="skeleton-shape" key={index} />
        ))}
      </div>
    </div>
  );
}

function SearchResultsSkeleton() {
  return (
    <div className="search-results-skeleton" role="status" aria-label="Söker i katalogen">
      <span className="sr-only">Söker i katalogen…</span>
      <span className="search-skeleton-kicker skeleton-shape" aria-hidden="true" />
      <div className="search-skeleton-party" aria-hidden="true">
        <span className="search-skeleton-avatar skeleton-shape" />
        <div>
          <span className="skeleton-shape" />
          <span className="skeleton-shape" />
          <span className="skeleton-shape" />
        </div>
      </div>
      <div className="search-skeleton-heading" aria-hidden="true">
        <span className="skeleton-shape" />
        <span className="skeleton-shape" />
      </div>
      <div className="search-skeleton-list" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="search-skeleton-row" key={index}>
            <span className="search-skeleton-avatar skeleton-shape" />
            <div>
              <span className="skeleton-shape" />
              <span className="skeleton-shape" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ClipGridSkeleton({ announce = true }: { announce?: boolean } = {}) {
  return (
    <div
      className="clip-grid skeleton-grid"
      role={announce ? "status" : undefined}
      aria-label={announce ? "Hämtar klipp" : undefined}
    >
      {announce && <span className="sr-only">Hämtar klipp…</span>}
      {Array.from({ length: 6 }, (_, index) => (
        <span className="skeleton-mini-clip skeleton-shape" aria-hidden="true" key={index} />
      ))}
    </div>
  );
}

function ProfileSkeleton({ variant }: { variant: "person" | "party" }) {
  return (
    <div className={`profile-skeleton ${variant}`} role="status" aria-label="Hämtar profil">
      <span className="sr-only">Hämtar profil…</span>
      <div className="profile-skeleton-hero" aria-hidden="true">
        <span className="profile-skeleton-avatar skeleton-shape" />
        <div className="profile-skeleton-copy">
          <span className="skeleton-shape" />
          <span className="skeleton-shape" />
          <span className="skeleton-shape" />
          <span className="skeleton-shape" />
        </div>
      </div>
      <div className="profile-skeleton-stats" aria-hidden="true">
        <span className="skeleton-shape" />
        <span className="skeleton-shape" />
      </div>
      <span className="profile-skeleton-label skeleton-shape" aria-hidden="true" />
      <ClipGridSkeleton announce={false} />
    </div>
  );
}

function BottomNav({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  const items: Array<{ tab: Tab; label: string; icon: React.ReactNode }> = [
    { tab: "hem", label: "Hem", icon: <Home size={23} /> },
    { tab: "foljer", label: "Följer", icon: <Users size={23} /> },
    { tab: "sok", label: "Sök", icon: <Search size={23} /> },
    { tab: "profil", label: "Profil", icon: <UserRound size={23} /> }
  ];
  return (
    <nav className="bottom-nav" aria-label="Primär">
      {items.map((item) => (
        <button key={item.tab} className={active === item.tab ? "active" : ""} onClick={() => onChange(item.tab)}>
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="panel-header">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </header>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="group">
      <div className="section-label">{title}</div>
      <div className="group-body">{children}</div>
    </section>
  );
}

function ListRow({
  avatar,
  eyebrow,
  title,
  subtitle,
  action,
  icon,
  tone,
  chevron,
  onClick
}: {
  avatar?: React.ReactNode;
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: "danger";
  chevron?: boolean;
  onClick?: () => void;
}) {
  const className = tone === "danger" ? "list-row danger" : "list-row";
  const lead = (
    <>
      {avatar}
      {icon && <span className="row-icon">{icon}</span>}
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <div className="row-copy">
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
    </>
  );
  const trail = (
    <>
      {action}
      {chevron && <ChevronRight className="chevron" size={17} />}
    </>
  );

  // A row that does something must be a button, or it is unreachable by
  // keyboard and invisible to a screen reader.
  //
  // But a row can have *two* things to do — open a person and unfollow them —
  // and wrapping the whole row in a button then nests the action's own button
  // inside it. That is invalid HTML, and browsers resolve it by making the
  // inner control unreliable: React logs "cannot contain a nested button" and
  // the keyboard can only reach the outer one. So when both are present, only
  // the lead half becomes a button and the action stays its sibling.
  if (onClick && action) {
    return (
      <div className={`${className} list-row--split`}>
        <button type="button" className="list-row-main" onClick={onClick}>
          {lead}
        </button>
        {trail}
      </div>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={`${className} list-row--button`} onClick={onClick}>
        {lead}
        {trail}
      </button>
    );
  }
  return (
    <div className={className}>
      {lead}
      {trail}
    </div>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button className={checked ? "switch on" : "switch"} role="switch" aria-checked={checked} onClick={onChange}>
      <span />
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Avatar({
  name,
  party,
  size,
  imageUrl
}: {
  name: string;
  party: PartyCode;
  size: "sm" | "md" | "lg" | "xl";
  imageUrl?: string | null;
}) {
  const partyProfile = PARTIES[party] ?? PARTIES.NONE;

  return (
    <span
      className={`avatar ${size}`}
      aria-hidden="true"
      title={imageUrl ? "Foto: Sveriges riksdag" : undefined}
      style={{
        background: partyTint(partyProfile.color),
        color: partyInk(partyProfile.color)
      }}
    >
      <span className="avatar-fallback">{initials(name)}</span>
      {imageUrl && (
        <AvatarImage key={imageUrl} imageUrl={imageUrl} priority={size === "xl"} />
      )}
    </span>
  );
}

function AvatarImage({ imageUrl, priority }: { imageUrl: string; priority: boolean }) {
  const [delivery, setDelivery] = useState(() => createPortraitDelivery(imageUrl));
  const imageRef = useRef<HTMLImageElement | null>(null);

  const handleImageError = useCallback(
    (image: HTMLImageElement) => {
      if (image !== imageRef.current) {
        return;
      }
      forgetPortraitSuccess(imageUrl, delivery.displayUrl);
      setDelivery((current) =>
        current.displayUrl === delivery.displayUrl
          ? retryPortraitDelivery(imageUrl, current)
          : current
      );
    },
    [delivery.displayUrl, imageUrl]
  );

  const confirmImageLoaded = useCallback(
    (image: HTMLImageElement) => {
      if (image !== imageRef.current || !isCompletePortraitImage(image)) {
        return;
      }
      rememberPortraitSuccess(imageUrl, delivery.displayUrl);
      setDelivery((current) =>
        current.displayUrl === delivery.displayUrl && (!current.loaded || current.failed)
          ? { ...current, loaded: true, failed: false }
          : current
      );
    },
    [delivery.displayUrl, imageUrl]
  );

  // A year-cached image may already be complete by the time React commits it.
  // Inspecting it synchronously means visibility never depends on a load event
  // that raced with a fast Search/Following unmount and remount.
  useLayoutEffect(() => {
    if (imageRef.current) {
      confirmImageLoaded(imageRef.current);
    }
  }, [confirmImageLoaded]);

  if (delivery.failed) {
    return null;
  }

  return (
    <img
      key={delivery.displayUrl}
      ref={imageRef}
      className={delivery.loaded ? "loaded" : ""}
      src={delivery.displayUrl}
      alt=""
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={priority ? "high" : "auto"}
      referrerPolicy="no-referrer"
      onLoad={(event) => {
        if (isCompletePortraitImage(event.currentTarget)) {
          confirmImageLoaded(event.currentTarget);
        } else {
          handleImageError(event.currentTarget);
        }
      }}
      onError={(event) => handleImageError(event.currentTarget)}
    />
  );
}

function PartyAvatar({
  party,
  color,
  size = "md"
}: {
  party: PartyCode;
  color?: string;
  size?: "md" | "xl";
}) {
  const profile = PARTIES[party];
  const partyColor = color ?? profile.color;
  return (
    <span
      className={`party-avatar ${size}`}
      style={{ background: partyTint(partyColor), color: partyInk(partyColor) }}
    >
      {profile.abbr}
    </span>
  );
}

/**
 * The person a clip belongs to, or `null` when nobody stable can be named.
 *
 * Built from what the clip already carries, so the feed needs no extra request.
 * `clipCount` is `null` here for the same reason: the feed does not know a
 * person's career total and must not guess one. The person page fetches it.
 *
 * Null means Riksdagen's `anforandelista` carried no `intressent_id` for that
 * speaker — today, a minister who is not a sitting MP (10 clips, 0.57% of the
 * catalogue on 2026-08-04). Callers must degrade rather than substitute: a
 * name-derived id would silently detach from the real person the day the
 * `intressent_id` is recovered, rotting the viewer's follow list invisibly.
 */
function personForClip(clip: ClipItem): Politician | null {
  if (clip.politicianId === null) {
    return null;
  }
  return {
    id: clip.politicianId,
    name: cleanName(clip.politicianName ?? clip.speakerName) || clip.speakerName,
    party: clip.party,
    role: clip.politicianRole ?? clip.anforandetyp ?? "",
    constituency: "",
    avatarUrl: clip.politicianAvatarUrl,
    clipCount: null
  };
}

/**
 * Tidy a name for display: drop the trailing `(M)` and a leading title.
 *
 * **Display only.** This is not an identity function and must never key
 * anything durable — that is `clip.politicianId` (`Q-2`). This used to feed a
 * slug that was the app's person key, and because it listed only four of the
 * dozens of Swedish ministerial titles it split the five most-clipped
 * ministers into two people each. Incomplete here now costs a clumsy label;
 * incomplete in a key cost 21.6% of the catalogue.
 *
 * The `ministern` rule is **greedy and has no `\b`**, both deliberately:
 *
 * - greedy, so a compound portfolio collapses in one step — "Gymnasie-,
 *   högskole- och forskningsministern Lotta Edholm" ends its title at the
 *   *last* segment, and a lazy match would leave "och forskningsministern".
 * - no word boundary, because "Finansmarknadsministern" has no boundary
 *   before "ministern"; `\bministern` matches neither it nor most of the
 *   compounds.
 *
 * It matches only the **definite** form with a following space, so the one
 * name shaped "Minister för civilt försvar Carl-Oskar Bohlin" is untouched
 * rather than mangled into "för civilt försvar Carl-Oskar Bohlin". Of the 23
 * titled names in the catalogue, this resolves 19; that one and the three
 * `TALMANNEN` chair rows keep their full string, which reads correctly.
 */
function cleanName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, "")
    .replace(/^.*ministern\s+/i, "")
    .replace(/^(Statsrådet|Ledamoten|Talmannen)\s+/i, "")
    .trim();
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("sv-SE", { notation: value >= 10000 ? "compact" : "standard" }).format(value);
}

function formatDate(value: string): string {
  if (!value) {
    return "Riksdagen";
  }
  return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = String(safe % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

export default App;
