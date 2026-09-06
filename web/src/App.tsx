import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  SetStateAction
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  Bookmark,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
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
  SignInButton,
  SignOutButton,
  SignUpButton,
  UserButton,
  useClerk
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
import {
  ANALYTICS_STATE_EVENT,
  QUALIFIED_IMPRESSION_DWELL_MS,
  QUALIFIED_IMPRESSION_FRACTION,
  QUALIFIED_VIEW_WATCH_MS,
  isAnalyticsEnabled,
  disableAnalytics,
  enableAnalytics,
  trackClipImpression,
  trackQualifiedView,
  trackVideoComplete,
  trackVideoProgress,
  trackVideoStart,
  trackWatchTime
} from "./analytics";
import type { FeedAnalyticsContext } from "./analytics";
import {
  readAnalyticsConsent,
  writeAnalyticsConsent
} from "./analytics-consent";
import type { AnalyticsConsentChoice } from "./analytics-consent";
import { AnalyticsConsentBanner } from "./AnalyticsConsentBanner";
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
  hasDecodedVideoFrame,
  isFeedAudioMuted,
  planMediaWindow,
  releaseMediaSource
} from "./feed/media-policy";
import { useSecondLookahead } from "./feed/network";
import {
  decideSnapTarget,
  dragScrollTop,
  isVerticalSwipeIntent,
  snapDuration,
  snapEaseOut,
  snapScrollTop
} from "./feed/snap-policy";
import {
  adjacentClipIndex,
  viewportSurface,
  type ViewportSurface
} from "./desktop/layout-policy";
import { DesktopRouteOutlet } from "./desktop/DesktopRouteOutlet";
import { createScrollMemory } from "./desktop/scroll-memory";
import { Onboarding } from "./onboarding";
import { EMPTY_ONBOARDING, readOnboarding, writeOnboarding } from "./onboarding-store";
import { EMPTY_LIBRARY, readLibrary, toggleInList, writeLibrary } from "./library-store";
import { LEGAL_PAGE_ORDER, LEGAL_PAGES, LEGAL_VERSION } from "./legal";
import type { LegalPageId } from "./legal";
import { personPathSlug, useAppNavigation } from "./navigation";
import { PartyLogo } from "./party-logo";
import { filterPartyMembers } from "./party-member-filter";
import { appendUniqueProfileClips } from "./profile-clip-order";
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
import { TopicSearchApiError } from "./search/api";
import { topicSearchEnabled } from "./search/feature";
import {
  EMPTY_TOPIC_SEARCH_STATE,
  TOPIC_SEARCH_RESULT_LIMIT,
  addDisabledFacet,
  beginTopicSearch,
  buildTopicRequestQuery,
  completeTopicSearch,
  dateBroadeningNotice,
  failTopicSearch,
  identityQueryAfterTopicRemoval,
  partyAfterTopicRemoval,
  rememberTopicSearchScroll,
  revealMoreTopicResults,
  sortedSearchFacets,
  topicResultHeading,
  topicSearchErrorMessage,
  visibleFacetLabel
} from "./search/state";
import type { TopicSearchState } from "./search/state";
import {
  createSearchFeedCollection,
  searchFeedHistoryId,
  withSearchFeedHistoryState
} from "./search/route";
import type { SearchFeedCollection } from "./search/route";
import { clipEntryFeed } from "./clip-entry";
import type {
  DisabledSearchFacet,
  SearchAmbiguityOption,
  SearchClipResult,
  SearchFacet
} from "./search/types";
import {
  loadClipsByIds,
  loadDebateClips,
  loadClipsForParty,
  loadClipsForPolitician,
  loadPartyProfile,
  loadPartyProfiles,
  loadPolitician,
  loadPoliticiansByIds,
  loadPoliticiansForParty,
  loadPublishedClipById,
  loadPublishedClips,
  searchPublishedTopics,
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
// Temporary product switch: keep the implementation intact while comments are
// unavailable, but expose no trigger or sheet to viewers.
const COMMENTS_ENABLED = false;

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
const PROFILE_CLIP_PAGE_SIZE = 60;
const ANALYTICS_PROMPT_DELAY_MS = 900;

/**
 * Visible fraction that counts as seeing a clip (prerequisite T-8).
 *
 * Written down once and used both to pick the active clip and, later, to decide
 * what an impression is. A metric with two definitions is a metric with none.
 */
const IMPRESSION_VISIBLE_FRACTION = QUALIFIED_IMPRESSION_FRACTION;

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

type FeedSwipeGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  velocitySampleY: number;
  velocitySampleTime: number;
  velocityY: number;
  currentIndex: number;
  itemHeight: number;
  vertical: boolean;
};

type FeedSnapAnimation = {
  frameId: number;
  targetIndex: number;
};

function useViewportSurface(): ViewportSurface {
  const [surface, setSurface] = useState(() => viewportSurface(window.innerWidth));

  useEffect(() => {
    const update = () => setSurface(viewportSurface(window.innerWidth));
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return surface;
}

function App({ initialClip = null }: { initialClip?: ClipItem | null }) {
  const { route, navigate, backTo } = useAppNavigation();
  const viewport = useViewportSurface();
  const tab = route.view === "clip" ? "hem" : route.tab;
  const feedMode = route.view === "clip" ? "fordig" : route.feedMode;
  const [searchFeedCollection, setSearchFeedCollection] =
    useState<SearchFeedCollection | null>(null);
  const [searchFeedOpen, setSearchFeedOpen] = useState(false);
  const searchFeedCollectionRef = useRef<SearchFeedCollection | null>(null);
  const searchFeedHistorySequenceRef = useRef(0);
  searchFeedCollectionRef.current = searchFeedCollection;
  const showingSearchFeed =
    searchFeedOpen &&
    searchFeedCollection !== null &&
    route.view === "tab" &&
    tab === "sok";
  const darkSurface =
    viewport === "mobile" &&
    (showingSearchFeed ||
      (route.view === "tab" && tab === "hem") ||
      route.view === "clip" ||
      route.view === "person-clips" ||
      route.view === "party-clips" ||
      route.view === "saved-clips");
  // Starts empty, not seeded with demo clips (FE-1). A brief loading state is
  // honest; a flash of fabricated content that then becomes real is not.
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [clipSource, setClipSource] = useState<ClipSource>("supabase");
  const [feedError, setFeedError] = useState<string | null>(null);
  const [feedNetworkFailed, setFeedNetworkFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  // A refresh belongs to the feed mode that requested it. A single boolean
  // leaked across a quick För dig -> Senaste switch, preserving the old slate
  // and eventually clearing the wrong request's loading state.
  const manualRefreshModeRef = useRef<FeedMode | null>(null);
  const preferenceSyncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [feedReloadKey, setFeedReloadKey] = useState(0);
  const [loadedFeedMode, setLoadedFeedMode] = useState<FeedMode | null>(null);
  const pwa = usePwaExperience(feedNetworkFailed);
  const [analyticsConsent, setAnalyticsConsent] = useState(readAnalyticsConsent);
  const [analyticsPromptReady, setAnalyticsPromptReady] = useState(false);
  const [analyticsSettingsOpen, setAnalyticsSettingsOpen] = useState(false);
  const selectedPersonId =
    route.view === "person" || route.view === "person-clips" ? route.personId : null;
  const selectedPartyCode =
    route.view === "party" || route.view === "party-clips" ? route.partyCode : null;
  const selectedEntryClipId = route.view === "clip" ? route.clipId : null;
  const [query, setQuery] = useState("");
  const [partyFilter, setPartyFilter] = useState<PartyCode | null>(null);
  const [topicSearchState, setTopicSearchState] = useState<TopicSearchState>(
    EMPTY_TOPIC_SEARCH_STATE
  );
  const searchFeedResponseRef = useRef(topicSearchState.response);
  const [muted, setMuted] = useState(false);
  // Follows, saves and likes now survive a reload. Device-local only — see
  // `library-store.ts` for why this is not a server call yet (C-1, C-2, C-6).
  const [library, setLibrary] = useState<LibraryState>(EMPTY_LIBRARY);
  // A scoped feed: one politician's clips, or the saved archive. Rendering it
  // through the same `FeedScreen` reuses the player, the FE-4 dwell activation
  // and the FE-3 loop instrumentation rather than growing a second one.
  const [collection, setCollection] = useState<ClipCollection | null>(null);
  const [entryClip, setEntryClip] = useState<ClipItem | null>(() =>
    route.view === "clip" && initialClip?.id === route.clipId ? initialClip : null
  );
  const [entryClipLoading, setEntryClipLoading] = useState(
    route.view === "clip" && initialClip?.id !== route.clipId
  );
  const [entryClipError, setEntryClipError] = useState<string | null>(null);
  const entryFeedClips = useMemo(() => clipEntryFeed(entryClip, clips), [clips, entryClip]);
  const [person, setPerson] = useState<Politician | null>(null);
  const [personClips, setPersonClips] = useState<ClipItem[]>([]);
  const [personLoading, setPersonLoading] = useState(false);
  const [personClipsLoadingMore, setPersonClipsLoadingMore] = useState(false);
  const [personClipsHasMore, setPersonClipsHasMore] = useState(false);
  const [personClipsPageError, setPersonClipsPageError] = useState<string | null>(null);
  const [party, setParty] = useState<PartyProfile | null>(null);
  const [personPartyPeers, setPersonPartyPeers] = useState<Politician[]>([]);
  const [partyProfiles, setPartyProfiles] = useState<PartyProfile[]>([]);
  const [partyProfilesLoading, setPartyProfilesLoading] = useState(true);
  const [partyClips, setPartyClips] = useState<ClipItem[]>([]);
  const [partyPoliticians, setPartyPoliticians] = useState<Politician[]>([]);
  const [partyLoading, setPartyLoading] = useState(false);
  const [partyClipsLoadingMore, setPartyClipsLoadingMore] = useState(false);
  const [partyClipsHasMore, setPartyClipsHasMore] = useState(false);
  const [partyClipsPageError, setPartyClipsPageError] = useState<string | null>(null);
  const selectedPersonIdRef = useRef(selectedPersonId);
  const selectedPartyCodeRef = useRef(selectedPartyCode);
  selectedPersonIdRef.current = selectedPersonId;
  selectedPartyCodeRef.current = selectedPartyCode;
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
  const topicSearchAvailable = topicSearchEnabled;
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
    if (analyticsConsent?.analytics === "granted") {
      enableAnalytics();
    } else {
      disableAnalytics();
    }
  }, [analyticsConsent?.analytics]);

  useEffect(() => {
    if (analyticsConsent !== null) {
      setAnalyticsPromptReady(false);
      return;
    }

    let revealTimer: number | null = null;
    const revealAfterPageLoad = () => {
      revealTimer = window.setTimeout(
        () => setAnalyticsPromptReady(true),
        ANALYTICS_PROMPT_DELAY_MS
      );
    };

    if (document.readyState === "complete") {
      revealAfterPageLoad();
    } else {
      window.addEventListener("load", revealAfterPageLoad, { once: true });
    }

    return () => {
      window.removeEventListener("load", revealAfterPageLoad);
      if (revealTimer !== null) {
        window.clearTimeout(revealTimer);
      }
    };
  }, [analyticsConsent]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
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

  useEffect(() => {
    const restoreSearchFeed = (event: PopStateEvent) => {
      const historyId = searchFeedHistoryId(event.state);
      setSearchFeedOpen(
        historyId !== null && historyId === searchFeedCollectionRef.current?.historyId
      );
    };
    window.addEventListener("popstate", restoreSearchFeed);
    return () => window.removeEventListener("popstate", restoreSearchFeed);
  }, []);

  useEffect(() => {
    if (searchFeedResponseRef.current === topicSearchState.response) {
      return;
    }
    searchFeedResponseRef.current = topicSearchState.response;
    searchFeedCollectionRef.current = null;
    setSearchFeedCollection(null);
    setSearchFeedOpen(false);
  }, [topicSearchState.response]);

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
    if (manualRefreshModeRef.current !== null) return;
    manualRefreshModeRef.current = feedMode;
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
    const preservingManualRefresh = manualRefreshModeRef.current === feedMode;
    if (manualRefreshModeRef.current !== null && !preservingManualRefresh) {
      // A mode change cancels the visual refresh owned by the previous mode.
      // The previous request is aborted by this effect's cleanup below.
      manualRefreshModeRef.current = null;
      setManualRefreshing(false);
    }
    setLoading(true);
    setFeedError(null);
    // Pull/Home refresh keeps the current frame in place until its replacement
    // is ready. Mode and preference changes still clear immediately so content
    // from the previous context is never presented as the new feed.
    if (!preservingManualRefresh) {
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
        const published = await loadPublishedClips(feedMode === "fordig" ? 240 : 60, {
          signal: controller.signal,
          cache: preservingManualRefresh ? "no-store" : "default"
        });
        return feedMode === "fordig"
          ? { ...published, clips: shuffledClips(published.clips) }
          : published;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (personalized) {
          const fallback = await loadPublishedClips(240, {
            signal: controller.signal,
            cache: preservingManualRefresh ? "no-store" : "default"
          });
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
        setLoadedFeedMode(feedMode);
        setClips(feed.clips);
        setClipSource(feed.source);
        setFeedError(feed.error ?? null);
        setFeedNetworkFailed(Boolean(feed.error));
      })
      .catch((error: unknown) => {
        if (!mounted || controller.signal.aborted) return;
        setLoadedFeedMode(feedMode);
        setClips([]);
        setFeedError(error instanceof Error ? error.message : "Okänt fel");
        setFeedNetworkFailed(true);
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
          if (
            preservingManualRefresh &&
            manualRefreshModeRef.current === feedMode
          ) {
            manualRefreshModeRef.current = null;
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

  // Route changes render before effects run. Tagging the loaded slate prevents
  // one frame of För dig from mounting under the Senaste tab (and vice versa),
  // including when Home is opened from another screen.
  const mainFeedClips = loadedFeedMode === feedMode ? clips : [];

  /**
   * A public watch URL is identified by the final clip id, never by its
   * decorative title slug. The prerendered bootstrap usually makes this
   * synchronous; this fetch is the direct-navigation and stale-page fallback.
   */
  useEffect(() => {
    if (selectedEntryClipId === null) {
      setEntryClip(null);
      setEntryClipLoading(false);
      setEntryClipError(null);
      return;
    }
    if (initialClip?.id === selectedEntryClipId) {
      setEntryClip(initialClip);
      setEntryClipLoading(false);
      setEntryClipError(null);
      return;
    }

    let active = true;
    setEntryClip(null);
    setEntryClipLoading(true);
    setEntryClipError(null);
    void loadPublishedClipById(selectedEntryClipId)
      .then((clip) => {
        if (!active) return;
        setEntryClip(clip);
        if (clip === null) {
          setEntryClipError("Klippet är inte längre tillgängligt.");
        }
      })
      .catch(() => {
        if (!active) return;
        setEntryClip(null);
        setEntryClipError("Klippet kunde inte hämtas. Försök igen om en stund.");
      })
      .finally(() => {
        if (active) setEntryClipLoading(false);
      });
    return () => {
      active = false;
    };
  }, [initialClip, selectedEntryClipId]);

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
      setPersonClipsHasMore(false);
      setPersonClipsLoadingMore(false);
      setPersonClipsPageError(null);
      return;
    }
    let active = true;
    setPersonLoading(true);
    setPerson(null);
    setPersonClips([]);
    setPersonClipsHasMore(false);
    setPersonClipsLoadingMore(false);
    setPersonClipsPageError(null);
    Promise.all([
      loadPolitician(selectedPersonId),
      loadClipsForPolitician(selectedPersonId, PROFILE_CLIP_PAGE_SIZE)
    ])
      .then(([politician, personClips]) => {
        if (active) {
          setPerson(politician);
          setPersonClips(personClips);
          setPersonClipsHasMore(
            politician?.clipCount === null
              ? personClips.length === PROFILE_CLIP_PAGE_SIZE
              : politician !== null && personClips.length < politician.clipCount
          );
        }
      })
      .catch(() => {
        if (active) {
          setPerson(null);
          setPersonClips([]);
          setPersonClipsHasMore(false);
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

  /**
   * Party colleagues for the desktop person page's side column.
   *
   * Keyed on the party rather than the person, so walking between two people
   * in the same party reuses the response. `party_profiles` is already loaded
   * for every party at startup, so the card beside this list costs no request
   * of its own.
   */
  useEffect(() => {
    const code = person?.party ?? null;
    if (code === null || code === "NONE") {
      setPersonPartyPeers([]);
      return;
    }
    let active = true;
    loadPoliticiansForParty(code)
      .then((peers) => {
        if (active) {
          setPersonPartyPeers(peers);
        }
      })
      .catch(() => {
        if (active) {
          setPersonPartyPeers([]);
        }
      });
    return () => {
      active = false;
    };
  }, [person?.party]);

  /** Load a party's canonical metadata, current people and recent catalogue. */
  useEffect(() => {
    if (selectedPartyCode === null) {
      setParty(null);
      setPartyClips([]);
      setPartyPoliticians([]);
      setPartyClipsHasMore(false);
      setPartyClipsLoadingMore(false);
      setPartyClipsPageError(null);
      return;
    }
    let active = true;
    setPartyLoading(true);
    setParty(null);
    setPartyClips([]);
    setPartyPoliticians([]);
    setPartyClipsHasMore(false);
    setPartyClipsLoadingMore(false);
    setPartyClipsPageError(null);
    Promise.all([
      loadPartyProfile(selectedPartyCode),
      loadClipsForParty(selectedPartyCode, PROFILE_CLIP_PAGE_SIZE),
      loadPoliticiansForParty(selectedPartyCode)
    ])
      .then(([profile, recentClips, politicians]) => {
        if (active) {
          setParty(profile);
          setPartyClips(recentClips);
          setPartyPoliticians(politicians);
          setPartyClipsHasMore(
            profile?.clipCount === null
              ? recentClips.length === PROFILE_CLIP_PAGE_SIZE
              : profile !== null && recentClips.length < profile.clipCount
          );
        }
      })
      .catch(() => {
        if (active) {
          setParty(null);
          setPartyClips([]);
          setPartyPoliticians([]);
          setPartyClipsHasMore(false);
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

  const loadMorePersonClips = async (): Promise<void> => {
    const personId = selectedPersonId;
    const after = personClips.at(-1) ?? null;
    if (
      personId === null ||
      after === null ||
      personClipsLoadingMore ||
      !personClipsHasMore
    ) {
      return;
    }

    setPersonClipsLoadingMore(true);
    setPersonClipsPageError(null);
    try {
      const nextPage = await loadClipsForPolitician(
        personId,
        PROFILE_CLIP_PAGE_SIZE,
        after
      );
      if (selectedPersonIdRef.current !== personId) {
        return;
      }
      const merged = appendUniqueProfileClips(personClips, nextPage);
      const total = person?.clipCount ?? null;
      setPersonClips(merged);
      setPersonClipsHasMore(
        nextPage.length === PROFILE_CLIP_PAGE_SIZE &&
          (total === null || merged.length < total)
      );
    } catch {
      if (selectedPersonIdRef.current === personId) {
        setPersonClipsPageError("Fler klipp kunde inte hämtas. Försök igen.");
      }
    } finally {
      if (selectedPersonIdRef.current === personId) {
        setPersonClipsLoadingMore(false);
      }
    }
  };

  const loadMorePartyClips = async (): Promise<void> => {
    const partyCode = selectedPartyCode;
    const after = partyClips.at(-1) ?? null;
    if (
      partyCode === null ||
      after === null ||
      partyClipsLoadingMore ||
      !partyClipsHasMore
    ) {
      return;
    }

    setPartyClipsLoadingMore(true);
    setPartyClipsPageError(null);
    try {
      const nextPage = await loadClipsForParty(
        partyCode,
        PROFILE_CLIP_PAGE_SIZE,
        after
      );
      if (selectedPartyCodeRef.current !== partyCode) {
        return;
      }
      const merged = appendUniqueProfileClips(partyClips, nextPage);
      const total = party?.clipCount ?? null;
      setPartyClips(merged);
      setPartyClipsHasMore(
        nextPage.length === PROFILE_CLIP_PAGE_SIZE &&
          (total === null || merged.length < total)
      );
    } catch {
      if (selectedPartyCodeRef.current === partyCode) {
        setPartyClipsPageError("Fler klipp kunde inte hämtas. Försök igen.");
      }
    } finally {
      if (selectedPartyCodeRef.current === partyCode) {
        setPartyClipsLoadingMore(false);
      }
    }
  };

  /** The party card beside a person, taken from the startup party_profiles read. */
  const personPartyProfile = useMemo(
    () =>
      person && person.party !== "NONE"
        ? partyProfiles.find((profile) => profile.abbr === person.party) ?? null
        : null,
    [partyProfiles, person]
  );

  const openPerson = (personId: string) => {
    setCollection(null);
    navigate({ view: "person", tab, feedMode, personId });
  };

  /**
   * Put the politician's name into the URL once it is known.
   *
   * Navigation only ever carries the id — every `onOpenPerson` caller has just
   * the `Q-2` identity — so the pushed path is `/politiker/<id>`. When the
   * profile row arrives, replace it with the canonical
   * `/politiker/<namn-slug>/<id>` that the prerenderer generates and that
   * `<link rel="canonical">` points at. `replace` is deliberate: this is the
   * same page, so it must not add a history entry the Back button has to walk.
   */
  useEffect(() => {
    if (person === null) {
      return;
    }
    if (route.view !== "person" && route.view !== "person-clips") {
      return;
    }
    if (route.personId !== person.id) {
      return;
    }
    const slug = personPathSlug(cleanName(person.name) || person.name);
    if (!slug || route.personSlug === slug) {
      return;
    }
    navigate({ ...route, personSlug: slug }, { replace: true });
  }, [navigate, person, route]);

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

  const openTopicSearchFeed = (startId: string | null, scrollTop: number) => {
    const response = topicSearchState.response;
    if (!topicSearchAvailable || topicSearchState.phase !== "success" || !response?.results.length) {
      return;
    }
    setTopicSearchState((current) => rememberTopicSearchScroll(current, scrollTop));
    searchFeedHistorySequenceRef.current += 1;
    const historyId = `search-feed-${searchFeedHistorySequenceRef.current}`;
    const nextCollection = createSearchFeedCollection(
      response.results,
      topicResultHeading(response.interpretation.facets),
      startId,
      historyId
    );
    searchFeedCollectionRef.current = nextCollection;
    setSearchFeedCollection(nextCollection);
    setSearchFeedOpen(true);
    // The URL deliberately stays unchanged: queries and result ids remain
    // transient, while browser Back still receives its own history boundary.
    window.history.pushState(
      withSearchFeedHistoryState(window.history.state, historyId),
      ""
    );
  };

  const closeTopicSearchFeed = () => {
    const currentHistoryId = searchFeedHistoryId(window.history.state);
    if (
      currentHistoryId !== null &&
      currentHistoryId === searchFeedCollectionRef.current?.historyId
    ) {
      window.history.back();
      return;
    }
    setSearchFeedOpen(false);
  };

  const openFollowing = () => {
    navigate({ view: "tab", tab: "foljer", feedMode });
  };

  const openLegal = (page: LegalPageId) => {
    navigate({ view: "legal", tab: "profil", feedMode, page });
  };

  const chooseAnalytics = (choice: AnalyticsConsentChoice) => {
    const previousChoice = analyticsConsent?.analytics ?? null;
    const next = writeAnalyticsConsent(choice);
    setAnalyticsConsent(next);
    setAnalyticsSettingsOpen(false);
    if (choice === "granted") {
      enableAnalytics();
    } else {
      disableAnalytics();
      // A loaded Google tag cannot be unloaded completely. Reloading only
      // after a withdrawal restores the same strict no-tag state as a first
      // visit that chose "Endast nödvändiga".
      if (previousChoice === "granted") {
        window.location.reload();
      }
    }
  };

  const openCookieInformation = () => {
    setAnalyticsSettingsOpen(false);
    openLegal("storage");
  };

  const closeDesktopRoute = useCallback(() => {
    if (showingSearchFeed) {
      closeTopicSearchFeed();
      return;
    }
    switch (route.view) {
      case "clip":
        backTo({ view: "tab", tab: "hem", feedMode: "fordig" });
        return;
      case "person":
      case "party":
        backTo({ view: "tab", tab: route.tab, feedMode });
        return;
      case "person-clips":
        backTo({ view: "person", tab: route.tab, feedMode, personId: route.personId });
        return;
      case "party-clips":
        backTo({ view: "party", tab: route.tab, feedMode, partyCode: route.partyCode });
        return;
      case "saved":
      case "legal":
        backTo({ view: "tab", tab: "profil", feedMode });
        return;
      case "saved-clips":
        backTo({ view: "saved", tab: "profil", feedMode });
        return;
      case "tab":
        return;
    }
  }, [backTo, feedMode, route, showingSearchFeed]);

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
      {viewport === "tablet-gate" && <WideScreenMessage />}
      <PwaStatusStack pwa={pwa} />
      {(analyticsSettingsOpen || (analyticsConsent === null && analyticsPromptReady)) && (
        <AnalyticsConsentBanner
          currentChoice={analyticsConsent?.analytics ?? null}
          settingsOpen={analyticsSettingsOpen}
          onChoose={chooseAnalytics}
          onClose={() => setAnalyticsSettingsOpen(false)}
          onOpenCookieInfo={openCookieInformation}
        />
      )}
      {viewer.signedIn && showOnboarding && (
        <Onboarding
          initial={onboarding}
          partyProfiles={partyProfiles}
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
      {viewport === "desktop" ? (
        <main key="desktop" className="desktop-app" aria-label="Pleni desktop">
          <DesktopSidebar
            active={route.view === "tab" ? route.tab : null}
            signedIn={viewer.signedIn}
            onSignIn={viewer.requireSignIn}
            onChange={(nextTab) => navigate({ view: "tab", tab: nextTab, feedMode })}
          />
          <div className="desktop-content">
            <DesktopRouteOutlet
              route={route}
              surfaceFocusKey={
                showingSearchFeed ? searchFeedCollection?.historyId ?? "search-feed" : null
              }
              onEscape={closeDesktopRoute}
              surfaces={{
                home: (
                  <FeedScreen
                    presentation="desktop"
                    clips={mainFeedClips}
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
                    onLike={toggleLikeClip}
                    onSave={toggleSaveClip}
                    onToggleFollow={toggleFollowPolitician}
                    onOpenPerson={openPerson}
                  />
                ),
                clip: route.view === "clip" ? (
                  <FeedScreen
                    presentation="desktop"
                    analyticsContext="seo_clip"
                    clips={entryFeedClips}
                    feedMode="fordig"
                    setFeedMode={changeFeedMode}
                    playbackSuspended={showOnboarding}
                    muted={muted}
                    setMuted={setMuted}
                    liked={liked}
                    saved={saved}
                    following={following}
                    loading={entryClipLoading}
                    clipSource={clipSource}
                    feedError={entryClipError}
                    onLike={toggleLikeClip}
                    onSave={toggleSaveClip}
                    onToggleFollow={toggleFollowPolitician}
                    onOpenPerson={openPerson}
                    initialClipId={route.clipId}
                    emptyMessage="Klippet är inte längre tillgängligt."
                  />
                ) : null,
                person: route.view === "person" ? (
                  <PersonScreen
                    presentation="desktop"
                    scrollKey={`person:${route.personId}`}
                    person={person}
                    clips={personClips}
                    loading={personLoading}
                    onBack={closePerson}
                    following={!!following[route.personId]}
                    onToggleFollow={() => toggleFollowPolitician(route.personId)}
                    onPlayClip={openPersonClips}
                    clipsHaveMore={personClipsHasMore}
                    clipsLoadingMore={personClipsLoadingMore}
                    clipsPageError={personClipsPageError}
                    onLoadMoreClips={() => void loadMorePersonClips()}
                    partyProfile={personPartyProfile}
                    partyPeers={personPartyPeers}
                    onOpenParty={openParty}
                    onOpenPerson={openPerson}
                  />
                ) : null,
                party: route.view === "party" ? (
                  <PartyScreen
                    presentation="desktop"
                    scrollKey={`party:${route.partyCode}`}
                    party={party}
                    clips={partyClips}
                    politicians={partyPoliticians}
                    loading={partyLoading}
                    onBack={closeParty}
                    following={!!followedParties[route.partyCode]}
                    onToggleFollow={() => toggleFollowParty(route.partyCode)}
                    onPlayClip={openPartyClips}
                    clipsHaveMore={partyClipsHasMore}
                    clipsLoadingMore={partyClipsLoadingMore}
                    clipsPageError={partyClipsPageError}
                    onLoadMoreClips={() => void loadMorePartyClips()}
                    onOpenPerson={openPerson}
                  />
                ) : null,
                "person-clips": route.view === "person-clips" ? (
                  <CollectionScreen
                    presentation="desktop"
                    analyticsContext="person"
                    collection={collection ?? { title: "Klipp", subtitle: "Laddar…", clips: [], startId: null }}
                    onBack={() => backTo({ view: "person", tab, feedMode, personId: route.personId })}
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
                ) : null,
                "party-clips": route.view === "party-clips" ? (
                  <CollectionScreen
                    presentation="desktop"
                    analyticsContext="party"
                    collection={collection ?? { title: "Klipp", subtitle: "Laddar…", clips: [], startId: null }}
                    onBack={() => backTo({ view: "party", tab, feedMode, partyCode: route.partyCode })}
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
                ) : null,
                search:
                  route.view === "tab" && route.tab === "sok" ? (
                    showingSearchFeed && searchFeedCollection !== null ? (
                      <CollectionScreen
                        presentation="desktop"
                        collection={searchFeedCollection}
                        analyticsContext="search"
                        onBack={closeTopicSearchFeed}
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
                    ) : (
                      <SearchScreen
                        presentation="desktop"
                        query={query}
                        setQuery={setQuery}
                        partyFilter={partyFilter}
                        setPartyFilter={setPartyFilter}
                        partyProfiles={partyProfiles}
                        partyProfilesLoading={partyProfilesLoading}
                        topicState={topicSearchState}
                        setTopicState={setTopicSearchState}
                        topicSearchAvailable={topicSearchAvailable}
                        onOpenPerson={openPerson}
                        onOpenParty={openParty}
                        onOpenTopicFeed={openTopicSearchFeed}
                      />
                    )
                  ) : null,
                following:
                  route.view === "tab" && route.tab === "foljer" ? (
                    <FollowingScreen
                      presentation="desktop"
                      signedIn={viewer.signedIn}
                      libraryReady={
                        viewer.signedIn &&
                        viewer.userId !== null &&
                        libraryLoadedUserId === viewer.userId
                      }
                      onSignIn={viewer.requireSignIn}
                      followedPoliticians={library.followedPoliticians}
                      followedParties={library.followedParties}
                      partyProfiles={partyProfiles}
                      personalizationAvailable={recommendationsEnabled}
                      personalizationEnabled={
                        recommendationsEnabled && recommendationProfile.personalization
                      }
                      onOpenForYou={() => changeFeedMode("fordig")}
                      onOpenLatest={() => changeFeedMode("senaste")}
                      onOpenSearch={() => navigate({ view: "tab", tab: "sok", feedMode })}
                      onOpenProfile={() => navigate({ view: "tab", tab: "profil", feedMode })}
                      onOpenLegal={openLegal}
                      onOpenPerson={openPerson}
                      onOpenParty={openParty}
                      onTogglePerson={toggleFollowPolitician}
                      onToggleParty={toggleFollowParty}
                    />
                  ) : null,
                profile:
                  route.view === "tab" && route.tab === "profil" ? (
                    <ProfileScreen
                      presentation="desktop"
                      signedIn={viewer.signedIn}
                      consent={consent}
                      analyticsChoice={analyticsConsent?.analytics ?? null}
                      onOpenAnalyticsSettings={() => setAnalyticsSettingsOpen(true)}
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
                  ) : null,
                saved:
                  route.view === "saved" ? (
                    <SavedScreen
                      presentation="desktop"
                      scrollKey="saved"
                      clips={savedClips}
                      loading={savedLoading}
                      error={savedError}
                      onBack={() => backTo({ view: "tab", tab: "profil", feedMode })}
                      onPlayClip={openSavedClip}
                    />
                  ) : null,
                "saved-clips":
                  route.view === "saved-clips" ? (
                    <CollectionScreen
                      presentation="desktop"
                      analyticsContext="saved"
                      collection={collection ?? { title: "Sparade klipp", subtitle: "Laddar…", clips: [], startId: null }}
                      onBack={() => backTo({ view: "saved", tab: "profil", feedMode })}
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
                  ) : null,
                legal:
                  route.view === "legal" ? (
                    <LegalScreen
                      presentation="desktop"
                      page={route.page}
                      onBack={() => backTo({ view: "tab", tab: "profil", feedMode })}
                      onNavigate={openLegal}
                      onOpenCookieSettings={() => setAnalyticsSettingsOpen(true)}
                    />
                  ) : null
              }}
            />
          </div>
        </main>
      ) : viewport === "mobile" ? (
      <main key="mobile" className="mobile-app" aria-label="Pleni">
        {showingSearchFeed && searchFeedCollection !== null ? (
          <CollectionScreen
            analyticsContext="search"
            collection={searchFeedCollection}
            onBack={closeTopicSearchFeed}
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
        ) : route.view === "legal" ? (
          <LegalScreen
            page={route.page}
            onBack={() => backTo({ view: "tab", tab: "profil", feedMode })}
            onNavigate={openLegal}
            onOpenCookieSettings={() => setAnalyticsSettingsOpen(true)}
          />
        ) : route.view === "person-clips" || route.view === "party-clips" || route.view === "saved-clips" ? (
          <CollectionScreen
            analyticsContext={
              route.view === "person-clips"
                ? "person"
                : route.view === "party-clips"
                  ? "party"
                  : "saved"
            }
            collection={
              collection ?? { title: "Klipp", subtitle: "Laddar…", clips: [], startId: null }
            }
            onBack={() =>
              backTo(
                route.view === "saved-clips"
                  ? { view: "saved", tab: "profil", feedMode }
                  : route.view === "person-clips"
                    ? { view: "person", tab, feedMode, personId: route.personId }
                    : { view: "party", tab, feedMode, partyCode: route.partyCode }
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
                analyticsContext={route.view === "clip" ? "seo_clip" : undefined}
                clips={route.view === "clip" ? entryFeedClips : mainFeedClips}
                feedMode={feedMode}
                setFeedMode={changeFeedMode}
                playbackSuspended={showOnboarding}
                muted={muted}
                setMuted={setMuted}
                liked={liked}
                saved={saved}
                following={following}
                loading={route.view === "clip" ? entryClipLoading : loading}
                clipSource={clipSource}
                feedError={route.view === "clip" ? entryClipError : feedError}
                onRefresh={refreshFeed}
                refreshing={manualRefreshing}
                onLike={toggleLikeClip}
                onSave={toggleSaveClip}
                onToggleFollow={toggleFollowPolitician}
                onOpenPerson={openPerson}
                initialClipId={route.view === "clip" ? route.clipId : null}
                emptyMessage={
                  route.view === "clip" ? "Klippet är inte längre tillgängligt." : undefined
                }
              />
            )}
            {tab === "foljer" && (
              <FollowingScreen
                signedIn={viewer.signedIn}
                libraryReady={
                  viewer.signedIn &&
                  viewer.userId !== null &&
                  libraryLoadedUserId === viewer.userId
                }
                onSignIn={viewer.requireSignIn}
                followedPoliticians={library.followedPoliticians}
                followedParties={library.followedParties}
                partyProfiles={partyProfiles}
                personalizationAvailable={recommendationsEnabled}
                personalizationEnabled={
                  recommendationsEnabled && recommendationProfile.personalization
                }
                onOpenForYou={() => changeFeedMode("fordig")}
                onOpenLatest={() => changeFeedMode("senaste")}
                onOpenSearch={() => navigate({ view: "tab", tab: "sok", feedMode })}
                onOpenProfile={() => navigate({ view: "tab", tab: "profil", feedMode })}
                onOpenLegal={openLegal}
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
                partyProfiles={partyProfiles}
                partyProfilesLoading={partyProfilesLoading}
                topicState={topicSearchState}
                setTopicState={setTopicSearchState}
                topicSearchAvailable={topicSearchAvailable}
                onOpenPerson={openPerson}
                onOpenParty={openParty}
                onOpenTopicFeed={openTopicSearchFeed}
              />
            )}
            {tab === "profil" && (
              <ProfileScreen
                signedIn={viewer.signedIn}
                consent={consent}
                analyticsChoice={analyticsConsent?.analytics ?? null}
                onOpenAnalyticsSettings={() => setAnalyticsSettingsOpen(true)}
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
      ) : null}
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

function DesktopSidebar({
  active,
  signedIn,
  onSignIn,
  onChange
}: {
  active: Tab | null;
  signedIn: boolean;
  onSignIn: () => void;
  onChange: (tab: Tab) => void;
}) {
  const items: Array<{ tab: Tab; label: string; icon: ReactNode }> = [
    { tab: "hem", label: "Hem", icon: <Home size={21} /> },
    { tab: "foljer", label: "Följer", icon: <Users size={21} /> },
    { tab: "sok", label: "Sök", icon: <Search size={21} /> },
    { tab: "profil", label: "Profil", icon: <UserRound size={21} /> }
  ];

  return (
    <aside className="desktop-sidebar" aria-label="Huvudmeny">
      <button className="desktop-brand" type="button" onClick={() => onChange("hem")}>
        <img src="/brand/pleni-logo.png" alt="" />
        <span>Pleni</span>
      </button>
      <nav>
        {items.map((item) => (
          <button
            key={item.tab}
            type="button"
            className={active === item.tab ? "active" : ""}
            aria-current={active === item.tab ? "page" : undefined}
            onClick={() => onChange(item.tab)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="desktop-account">
        {clerkEnabled && signedIn ? (
          <DesktopSidebarAccount onOpen={() => onChange("profil")} />
        ) : (
          <button type="button" onClick={onSignIn} disabled={!clerkEnabled}>
            <UserRound size={18} />
            <span>{clerkEnabled ? "Logga in" : "Konto ej anslutet"}</span>
          </button>
        )}
      </div>
    </aside>
  );
}

/**
 * The sidebar's account row.
 *
 * Pleni's own avatar and name rather than a second `<UserButton>`: the widget
 * appeared here and on the Profil tab, drawing Clerk's typography twice in a
 * shell that is otherwise this product's. Opening the tab is what the row was
 * for anyway.
 */
function DesktopSidebarAccount({ onOpen }: { onOpen: () => void }) {
  const { user } = useClerk();
  const displayName = user?.fullName ?? user?.username ?? "Mitt konto";
  const imageUrl = user?.imageUrl ?? null;

  return (
    <button type="button" className="desktop-account-me" onClick={onOpen}>
      <span className="desktop-account-avatar" aria-hidden="true">
        {imageUrl ? <img src={imageUrl} alt="" /> : <span>{initials(displayName)}</span>}
      </span>
      <span>{displayName}</span>
    </button>
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

  const revealDecodedFrame = (video: HTMLVideoElement) => {
    if (mediaRef.current === video && hasDecodedVideoFrame(video.readyState)) {
      setFrameReady(true);
    }
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
    >
      <div className="feed-video-frame" onClick={onTogglePlayback}>
      {posterSrc && !frameReady && <img className="feed-poster" src={posterSrc} alt="" />}
      {mediaMounted && (
        /* The overlay owns the cold-load fallback. A native `poster` would sit
           above this decoded preload again and flash when playback activates. */
        <video
          ref={bindMediaRef}
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
            revealDecodedFrame(event.currentTarget);
          }}
          onCanPlay={(event) => {
            setBuffering(false);
            revealDecodedFrame(event.currentTarget);
            onPlayable();
          }}
          onPlaying={(event) => {
            setBuffering(false);
            revealDecodedFrame(event.currentTarget);
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
      </div>
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
    </article>
  );
}

function FeedScreen({
  clips: suppliedClips,
  presentation = "mobile",
  analyticsContext,
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
  presentation?: "mobile" | "desktop";
  analyticsContext?: FeedAnalyticsContext;
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
  const [debateContext, setDebateContext] = useState<{
    clips: ClipItem[];
    startId: string;
    title: string;
  } | null>(null);
  const clips = presentation === "desktop" && debateContext
    ? debateContext.clips
    : suppliedClips;
  const effectiveAnalyticsContext: FeedAnalyticsContext = debateContext
    ? "debate"
    : analyticsContext ?? (feedMode === "fordig" ? "home_for_you" : "home_latest");
  const mainFeedActiveId = useRef<string | null>(initialClipId);
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
  const [autoplayMutedClipId, setAutoplayMutedClipId] = useState<string | null>(null);
  const secondLookaheadAllowed = useSecondLookahead();
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const swipeGestureRef = useRef<FeedSwipeGesture | null>(null);
  const snapAnimationRef = useRef<FeedSnapAnimation | null>(null);
  const controlledSnapActiveRef = useRef(false);
  const suppressFeedClickUntilRef = useRef(0);
  const pullStartY = useRef<number | null>(null);
  const pullDistanceRef = useRef(0);
  const wasRefreshingRef = useRef(false);
  const previousFeedModeRef = useRef(feedMode);
  const resetToFirstClipRef = useRef(false);
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
  const analyticsRatiosRef = useRef<Record<string, number>>({});
  const analyticsWatchMsRef = useRef<Record<string, number>>({});
  const [analyticsRevision, setAnalyticsRevision] = useState(0);
  activeIdRef.current = activeId;
  playbackSuspendedRef.current = playbackSuspended;
  commentClipRef.current = commentClip;

  useEffect(() => {
    const refreshAnalyticsState = () => setAnalyticsRevision((revision) => revision + 1);
    window.addEventListener(ANALYTICS_STATE_EVENT, refreshAnalyticsState);
    return () => window.removeEventListener(ANALYTICS_STATE_EVENT, refreshAnalyticsState);
  }, []);

  const activateClip = useCallback(
    (clipId: string) => {
      if (!clipId || clipId === activeIdRef.current) {
        return;
      }
      const previousIndex = clips.findIndex((clip) => clip.id === activeIdRef.current);
      const nextIndex = clips.findIndex((clip) => clip.id === clipId);
      if (nextIndex < 0) {
        return;
      }
      if (previousIndex >= 0) {
        setPredictedDirection(nextIndex > previousIndex ? 1 : -1);
      }
      // Keep imperative gesture and observer work on the same current value
      // before React renders the state update.
      activeIdRef.current = clipId;
      setActiveId(clipId);
    },
    [clips]
  );
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
  const autoplayMutedClipIdRef = useRef<string | null>(null);
  const effectiveMuted = isFeedAudioMuted(muted, autoplayMutedClipId, activeId);

  useEffect(() => {
    if (previousFeedModeRef.current === feedMode) {
      return;
    }
    previousFeedModeRef.current = feedMode;
    resetToFirstClipRef.current = true;
    mainFeedActiveId.current = null;
    activeIdRef.current = "";
    setActiveId("");
    feedScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [feedMode]);

  useEffect(() => {
    // A collection opened from a grid starts on the clip that was tapped, not
    // at the top; falling back to the first clip if that id is not in the set.
    const resetToFirstClip = resetToFirstClipRef.current;
    const openingClipId = resetToFirstClip
      ? null
      : debateContext?.startId ?? mainFeedActiveId.current ?? initialClipId;
    const wanted = openingClipId && clips.some((clip) => clip.id === openingClipId)
      ? openingClipId
      : clips[0]?.id ?? "";
    setActiveId(wanted);
    setPaused({});
    setBlocked({});
    setPlaybackFlash(null);
    setShareFeedback(null);
    setPredictedDirection(1);
    setPlayableGeneration(null);
    autoplayMutedClipIdRef.current = null;
    setAutoplayMutedClipId(null);
    loopCounts.current = {};
    if (resetToFirstClip && clips.length > 0) {
      mainFeedActiveId.current = wanted || null;
      resetToFirstClipRef.current = false;
    }
  }, [clips, debateContext, initialClipId]);

  useEffect(() => {
    if (debateContext === null && activeId) {
      mainFeedActiveId.current = activeId;
    }
  }, [activeId, debateContext]);

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
      resetToFirstClipRef.current = true;
      mainFeedActiveId.current = null;
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
    const openingClipId = debateContext?.startId ?? mainFeedActiveId.current ?? initialClipId;
    if (!openingClipId) {
      return;
    }
    const node = document.querySelector(`article[data-clip-id="${CSS.escape(openingClipId)}"]`);
    node?.scrollIntoView({ block: "start" });
  }, [clips, debateContext, initialClipId]);

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
        autoplayMutedClipIdRef.current = clipId;
        setAutoplayMutedClipId(clipId);
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
    const clip = clips.find((candidate) => candidate.id === clipId);
    if (
      clip &&
      clipSource === "supabase" &&
      document.visibilityState === "visible" &&
      (analyticsRatiosRef.current[clipId] ?? 0) >= QUALIFIED_IMPRESSION_FRACTION
    ) {
      trackVideoComplete(clip, effectiveAnalyticsContext);
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
    if (commentClip && commentClip.id !== activeId) {
      resumeAfterComments.current = false;
      setCommentClip(null);
    }
  }, [activeId, commentClip]);

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

  const controlledSwipeSupported =
    typeof window !== "undefined" && "PointerEvent" in window;

  const finishControlledSnap = useCallback((targetIndex: number) => {
    const animation = snapAnimationRef.current;
    if (animation !== null) {
      window.cancelAnimationFrame(animation.frameId);
      snapAnimationRef.current = null;
    }
    const scroll = feedScrollRef.current;
    if (scroll) {
      scroll.scrollTop = snapScrollTop(targetIndex, clips.length, scroll.clientHeight);
      delete scroll.dataset.swipeActive;
    }
    swipeGestureRef.current = null;
    controlledSnapActiveRef.current = false;
  }, [clips.length]);

  const settleControlledSnap = useCallback(
    (targetIndex: number) => {
      const scroll = feedScrollRef.current;
      if (!scroll) {
        controlledSnapActiveRef.current = false;
        return;
      }
      if (snapAnimationRef.current !== null) {
        finishControlledSnap(snapAnimationRef.current.targetIndex);
      }

      const startTop = scroll.scrollTop;
      const targetTop = snapScrollTop(targetIndex, clips.length, scroll.clientHeight);
      const duration = snapDuration(
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      );
      if (duration === 0 || Math.abs(targetTop - startTop) < 0.5) {
        finishControlledSnap(targetIndex);
        return;
      }

      scroll.dataset.swipeActive = "true";
      controlledSnapActiveRef.current = true;
      const startedAt = performance.now();
      const animation: FeedSnapAnimation = { frameId: 0, targetIndex };
      snapAnimationRef.current = animation;

      const step = (now: number) => {
        if (snapAnimationRef.current !== animation) {
          return;
        }
        const progress = Math.min((now - startedAt) / duration, 1);
        scroll.scrollTop = startTop + (targetTop - startTop) * snapEaseOut(progress);
        if (progress >= 1) {
          finishControlledSnap(targetIndex);
          return;
        }
        animation.frameId = window.requestAnimationFrame(step);
      };
      animation.frameId = window.requestAnimationFrame(step);
    },
    [clips.length, finishControlledSnap]
  );

  const moveOneClip = useCallback(
    (direction: -1 | 1) => {
      if (commentClipRef.current !== null) return;
      const currentIndex = Math.max(
        clips.findIndex((clip) => clip.id === activeIdRef.current),
        0
      );
      const targetIndex = adjacentClipIndex(currentIndex, clips.length, direction);
      const targetId = clips[targetIndex]?.id;
      if (!targetId || targetIndex === currentIndex) return;
      activateClip(targetId);
      settleControlledSnap(targetIndex);
    },
    [activateClip, clips, settleControlledSnap]
  );

  useEffect(() => {
    if (presentation !== "desktop") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT"
      ) {
        return;
      }
      if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        moveOneClip(-1);
      } else if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        moveOneClip(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moveOneClip, presentation]);

  const cancelControlledGesture = useCallback(() => {
    const gesture = swipeGestureRef.current;
    if (gesture?.vertical) {
      finishControlledSnap(gesture.currentIndex);
      return;
    }
    swipeGestureRef.current = null;
    controlledSnapActiveRef.current = false;
  }, [finishControlledSnap]);

  useLayoutEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        return;
      }
      if (snapAnimationRef.current !== null) {
        finishControlledSnap(snapAnimationRef.current.targetIndex);
      } else {
        cancelControlledGesture();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (snapAnimationRef.current !== null) {
        finishControlledSnap(snapAnimationRef.current.targetIndex);
      } else {
        cancelControlledGesture();
      }
    };
  }, [cancelControlledGesture, finishControlledSnap]);

  const handleFeedPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!controlledSwipeSupported || event.pointerType === "mouse") {
      return;
    }
    if (!event.isPrimary) {
      cancelControlledGesture();
      return;
    }
    if ((event.target as Element).closest(".progress-track")) {
      return;
    }
    if (snapAnimationRef.current !== null) {
      // A fast second swipe starts from a fully aligned card, not halfway
      // through the prior 140 ms settlement.
      finishControlledSnap(snapAnimationRef.current.targetIndex);
    }

    const scroll = event.currentTarget;
    const itemHeight = scroll.clientHeight;
    if (itemHeight <= 0 || clips.length === 0) {
      return;
    }
    const currentIndex = Math.min(
      Math.max(Math.round(scroll.scrollTop / itemHeight), 0),
      clips.length - 1
    );
    scroll.scrollTop = currentIndex * itemHeight;
    swipeGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      velocitySampleY: event.clientY,
      velocitySampleTime: event.timeStamp,
      velocityY: 0,
      currentIndex,
      itemHeight,
      vertical: false
    };
  };

  const handleFeedPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = swipeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.vertical) {
      // The current production feed owns a downward gesture at the first item
      // as pull-to-refresh. Leave that established interaction to its touch
      // handler instead of turning it into a rejected previous-card swipe.
      if (gesture.currentIndex === 0 && deltaY > 0 && onRefresh) {
        swipeGestureRef.current = null;
        return;
      }
      if (!isVerticalSwipeIntent(deltaX, deltaY)) {
        if (Math.abs(deltaX) >= 8 && Math.abs(deltaX) >= Math.abs(deltaY)) {
          swipeGestureRef.current = null;
        }
        return;
      }
      gesture.vertical = true;
      controlledSnapActiveRef.current = true;
      event.currentTarget.dataset.swipeActive = "true";
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    event.preventDefault();
    const sampleDuration = event.timeStamp - gesture.velocitySampleTime;
    if (sampleDuration >= 40) {
      gesture.velocityY = (event.clientY - gesture.velocitySampleY) / sampleDuration;
      gesture.velocitySampleY = event.clientY;
      gesture.velocitySampleTime = event.timeStamp;
    }
    event.currentTarget.scrollTop = dragScrollTop({
      currentIndex: gesture.currentIndex,
      itemCount: clips.length,
      itemHeight: gesture.itemHeight,
      dragDeltaY: deltaY
    });
  };

  const handleFeedPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = swipeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    swipeGestureRef.current = null;
    if (!gesture.vertical) {
      return;
    }
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const velocityDuration = event.timeStamp - gesture.velocitySampleTime;
    const releaseDeltaY = event.clientY - gesture.velocitySampleY;
    const velocityY = velocityDuration > 0 && velocityDuration <= 120
      ? Math.abs(releaseDeltaY) >= 0.5
        ? releaseDeltaY / velocityDuration
        : gesture.velocityY
      : 0;
    const targetIndex = decideSnapTarget({
      currentIndex: gesture.currentIndex,
      itemCount: clips.length,
      itemHeight: gesture.itemHeight,
      dragDeltaY: event.clientY - gesture.startY,
      velocityY
    });
    const targetClipId = clips[targetIndex]?.id;
    if (targetClipId) {
      // The target is guaranteed to become the settled card, so it is safe to
      // begin its already-preloaded video while the last 140 ms completes.
      activateClip(targetClipId);
    }
    suppressFeedClickUntilRef.current = performance.now() + 450;
    settleControlledSnap(targetIndex);
  };

  const handleFeedPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = swipeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    cancelControlledGesture();
  };

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
      if (controlledSnapActiveRef.current) {
        return;
      }
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
        if (pendingWinner !== null && !controlledSnapActiveRef.current) {
          activateClip(pendingWinner);
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
  }, [activateClip, clips]);

  /**
   * A feed impression is deliberately stricter than activation: one winning
   * clip must occupy 72% of its own feed viewport for a continuous second,
   * with the page visible. Fast swipes, neighboring preload rows and hidden
   * tabs therefore never become views.
   */
  useEffect(() => {
    const scroll = feedScrollRef.current;
    analyticsRatiosRef.current = {};
    if (!scroll || !isAnalyticsEnabled()) return;

    let pendingWinner: string | null = null;
    let dwellTimer: number | null = null;

    const cancelDwell = () => {
      pendingWinner = null;
      if (dwellTimer !== null) {
        window.clearTimeout(dwellTimer);
        dwellTimer = null;
      }
    };

    const bestVisibleClip = (): string | null => {
      let best: string | null = null;
      let bestRatio = QUALIFIED_IMPRESSION_FRACTION;
      Object.entries(analyticsRatiosRef.current).forEach(([clipId, ratio]) => {
        if (ratio >= bestRatio) {
          best = clipId;
          bestRatio = ratio;
        }
      });
      return best;
    };

    const schedule = () => {
      if (document.visibilityState !== "visible" || playbackSuspendedRef.current) {
        cancelDwell();
        return;
      }
      const winner = bestVisibleClip();
      if (winner === null) {
        cancelDwell();
        return;
      }
      if (winner === pendingWinner) return;
      cancelDwell();
      pendingWinner = winner;
      dwellTimer = window.setTimeout(() => {
        dwellTimer = null;
        if (
          pendingWinner !== winner ||
          document.visibilityState !== "visible" ||
          playbackSuspendedRef.current ||
          activeIdRef.current !== winner ||
          (analyticsRatiosRef.current[winner] ?? 0) < QUALIFIED_IMPRESSION_FRACTION
        ) {
          return;
        }
        const clipIndex = clips.findIndex((clip) => clip.id === winner);
        const clip = clips[clipIndex];
        if (clip && clipSource === "supabase") {
          trackClipImpression(clip, effectiveAnalyticsContext, clipIndex);
        }
      }, QUALIFIED_IMPRESSION_DWELL_MS);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const clipId = (entry.target as HTMLElement).dataset.clipId;
          if (clipId) analyticsRatiosRef.current[clipId] = entry.intersectionRatio;
        });
        schedule();
      },
      { root: scroll, threshold: [0, 0.25, 0.5, QUALIFIED_IMPRESSION_FRACTION, 0.9, 1] }
    );
    scroll.querySelectorAll<HTMLElement>("[data-clip-id]").forEach((element) => observer.observe(element));
    document.addEventListener("visibilitychange", schedule);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      cancelDwell();
      analyticsRatiosRef.current = {};
    };
  }, [analyticsRevision, clipSource, clips, effectiveAnalyticsContext, playbackSuspended]);

  /** Count only wall-clock time during real, foreground playback. */
  useEffect(() => {
    const clip = clips.find((candidate) => candidate.id === activeId);
    if (!clip || clipSource !== "supabase" || clip.isSample || !isAnalyticsEnabled()) {
      return;
    }
    let lastTick = performance.now();
    const tick = () => {
      const now = performance.now();
      const elapsed = Math.min(1_000, Math.max(0, now - lastTick));
      lastTick = now;
      const video = videoRefs.current[clip.id];
      const eligible =
        isAnalyticsEnabled() &&
        document.visibilityState === "visible" &&
        !playbackSuspendedRef.current &&
        commentClipRef.current === null &&
        activeIdRef.current === clip.id &&
        (analyticsRatiosRef.current[clip.id] ?? 0) >= QUALIFIED_IMPRESSION_FRACTION &&
        video !== null &&
        video !== undefined &&
        !video.paused &&
        !video.ended &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
      if (!eligible || !video) return;

      trackVideoStart(clip, effectiveAnalyticsContext);
      const total = (analyticsWatchMsRef.current[clip.id] ?? 0) + elapsed;
      analyticsWatchMsRef.current[clip.id] = total;
      if (total >= QUALIFIED_VIEW_WATCH_MS) {
        trackQualifiedView(clip, effectiveAnalyticsContext);
      }
      trackVideoProgress(
        clip,
        effectiveAnalyticsContext,
        video.currentTime,
        Number.isFinite(video.duration) ? video.duration : clip.durationS
      );
      if (video.duration > 0 && video.currentTime / video.duration >= 0.95) {
        trackVideoComplete(clip, effectiveAnalyticsContext);
      }
    };

    const interval = window.setInterval(tick, 250);
    return () => {
      window.clearInterval(interval);
      const watched = analyticsWatchMsRef.current[clip.id] ?? 0;
      trackWatchTime(clip, effectiveAnalyticsContext, watched);
      delete analyticsWatchMsRef.current[clip.id];
    };
  }, [activeId, analyticsRevision, clipSource, clips, effectiveAnalyticsContext]);

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
      video.muted = isFeedAudioMuted(muted, autoplayMutedClipIdRef.current, clipId);
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
        video.muted = effectiveMuted;
      }
    });
  }, [effectiveMuted]);

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

  const chooseMuted = (nextMuted: boolean) => {
    // Only this control creates a persistent viewer mute. Clearing the
    // autoplay fallback here lets an explicit unmute take effect immediately
    // inside the same user gesture, which satisfies mobile autoplay policy.
    autoplayMutedClipIdRef.current = null;
    setAutoplayMutedClipId(null);
    setMuted(nextMuted);

    const clipId = activeIdRef.current;
    const video = videoRefs.current[clipId];
    if (!video) {
      return;
    }
    video.muted = nextMuted;
    if (!nextMuted && video.paused) {
      void video
        .play()
        .then(() => {
          setPaused((state) => ({ ...state, [clipId]: false }));
          setBlocked((state) => ({ ...state, [clipId]: false }));
        })
        .catch(() => {
          setPaused((state) => ({ ...state, [clipId]: true }));
          setBlocked((state) => ({ ...state, [clipId]: true }));
        });
    }
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
    if (autoplayMutedClipIdRef.current === clipId) {
      chooseMuted(false);
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
  const activeClip = clips[windowCentre] ?? null;
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
    <section className={`feed-screen feed-screen--${presentation}`}>
      <div className="feed-stage">
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
      {debateContext ? (
        <div className="collection-bar desktop-debate-bar">
          <button
            type="button"
            onClick={() => {
              const returnId = mainFeedActiveId.current;
              setDebateContext(null);
              if (returnId) {
                activeIdRef.current = returnId;
                setActiveId(returnId);
              }
            }}
            aria-label="Tillbaka till flödet"
          >
            <ChevronLeft size={22} />
          </button>
          <span className="collection-copy">
            <strong>{debateContext.title}</strong>
            <small>Tillbaka till flödet</small>
          </span>
        </div>
      ) : header ?? (
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
        className={[
          "feed-scroll",
          pulling ? "feed-scroll--pulling" : "",
          controlledSwipeSupported ? "feed-scroll--controlled" : ""
        ].filter(Boolean).join(" ")}
        ref={feedScrollRef}
        style={{ transform: `translate3d(0, ${pullOffset}px, 0)` }}
        onPointerDown={handleFeedPointerDown}
        onPointerMove={handleFeedPointerMove}
        onPointerUp={handleFeedPointerUp}
        onPointerCancel={handleFeedPointerCancel}
        onClickCapture={(event) => {
          if (performance.now() <= suppressFeedClickUntilRef.current) {
            suppressFeedClickUntilRef.current = 0;
            event.preventDefault();
            event.stopPropagation();
          }
        }}
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
              muted={effectiveMuted}
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
                chooseMuted(!effectiveMuted);
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
      {presentation === "desktop" && (
        <div className="desktop-feed-nav" aria-label="Byt klipp">
          <button
            type="button"
            aria-label="Föregående klipp"
            disabled={windowCentre <= 0}
            onClick={() => moveOneClip(-1)}
          >
            <ArrowUp size={20} />
          </button>
          <button
            type="button"
            aria-label="Nästa klipp"
            disabled={windowCentre >= clips.length - 1}
            onClick={() => moveOneClip(1)}
          >
            <ArrowDown size={20} />
          </button>
        </div>
      )}
      </div>
      {presentation === "desktop" && (
        <aside className="desktop-inspector" aria-label="Om klippet">
          {COMMENTS_ENABLED && commentClip ? (
            <CommentSheet clip={commentClip} onClose={closeComments} presentation="inspector" />
          ) : activeClip ? (
            <DesktopClipInspector
              clip={activeClip}
              inDebateFeed={debateContext !== null}
              onOpenPerson={onOpenPerson}
              onOpenDebate={(debateClips, startId) => {
                if (debateContext === null) {
                  mainFeedActiveId.current = activeId;
                }
                setDebateContext({
                  clips: debateClips,
                  startId,
                  title: activeClip.sourceTitle
                });
              }}
            />
          ) : (
            <div className="desktop-inspector-empty">Klippinformation visas här.</div>
          )}
        </aside>
      )}
      {presentation === "mobile" && (
        <>
          {COMMENTS_ENABLED && commentClip && <CommentSheet clip={commentClip} onClose={closeComments} />}
        </>
      )}
    </section>
  );
}

function DesktopClipInspector({
  clip,
  inDebateFeed,
  onOpenPerson,
  onOpenDebate
}: {
  clip: ClipItem;
  inDebateFeed: boolean;
  onOpenPerson: (personId: string) => void;
  onOpenDebate: (clips: ClipItem[], startId: string) => void;
}) {
  const [debateClips, setDebateClips] = useState<ClipItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const person = personForClip(clip);
  const party = PARTIES[clip.party];

  useEffect(() => {
    if (!clip.sourceId) {
      setDebateClips([]);
      setLoading(false);
      setError(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void loadDebateClips(clip.sourceId, 60, controller.signal)
      .then(setDebateClips)
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setDebateClips([]);
        setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [clip.sourceId]);

  const activePosition = debateClips.findIndex((candidate) => candidate.id === clip.id);
  const orderedRelated = activePosition >= 0
    ? [...debateClips.slice(activePosition + 1), ...debateClips.slice(0, activePosition)]
    : debateClips;
  const related = orderedRelated.filter((candidate) => candidate.id !== clip.id).slice(0, 3);
  const displayName = cleanName(clip.speakerName) || person?.name || clip.speakerName;
  const excerpt = clip.transcript.trim() || clip.title;

  return (
    <div className="desktop-inspector-content" key={clip.id}>
      <div className="desktop-inspector-kicker">Om klippet</div>
      <button
        type="button"
        className="desktop-speaker"
        disabled={!person}
        onClick={() => person && onOpenPerson(person.id)}
      >
        <Avatar
          name={displayName}
          party={clip.party}
          size="md"
          imageUrl={person?.avatarUrl ?? clip.politicianAvatarUrl}
        />
        <span>
          <strong>{displayName}</strong>
          <small>
            <i style={{ background: party.color }} />
            {party.abbr !== "NONE" ? `${party.abbr} · ` : ""}
            {clip.anforandetyp || clip.politicianRole || "Talare"}
          </small>
        </span>
        {person && <ChevronRight size={18} aria-hidden="true" />}
      </button>

      <h1>{clip.title}</h1>
      <p>{excerpt}</p>
      <a className="desktop-source" href={clip.sourceUrl} target="_blank" rel="noreferrer">
        <span>
          <small>{formatDate(clip.debateDate)}</small>
          <strong>{clip.sourceTitle}</strong>
        </span>
        <ArrowUpRight size={17} />
      </a>

      <div className="desktop-related-heading">
        <strong>Fler klipp i debatten</strong>
        {inDebateFeed && <span>Debattflöde</span>}
      </div>
      {loading ? (
        <div className="desktop-related-status"><LoaderCircle size={17} /> Hämtar klipp…</div>
      ) : error ? (
        <div className="desktop-related-status">Kunde inte hämta fler klipp.</div>
      ) : related.length === 0 ? (
        <div className="desktop-related-status">Inga fler publicerade klipp från debatten.</div>
      ) : (
        <div className="desktop-related-list">
          {related.map((candidate) => (
            <button
              type="button"
              key={candidate.id}
              onClick={() => onOpenDebate(debateClips, candidate.id)}
            >
              <img src={candidate.thumbUrl} alt="" loading="lazy" />
              <span>
                <strong>{candidate.title}</strong>
                <small>{cleanName(candidate.speakerName)}</small>
              </span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
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
  presentation = "mobile",
  analyticsContext,
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
  presentation?: "mobile" | "desktop";
  analyticsContext: FeedAnalyticsContext;
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
      presentation={presentation}
      analyticsContext={analyticsContext}
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
        <div className={presentation === "desktop" ? "collection-bar desktop-debate-bar" : "collection-bar"}>
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
      {COMMENTS_ENABLED && (
        <ActionButton label="Kommentarer" hideLabel onClick={onComments}>
          <MessageCircle size={21} />
        </ActionButton>
      )}
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

function CommentSheet({
  clip,
  onClose,
  presentation = "sheet"
}: {
  clip: ClipItem;
  onClose: () => void;
  presentation?: "sheet" | "inspector";
}) {
  const viewer = useViewer();
  const titleRef = useRef<HTMLHeadingElement | null>(null);
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

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const sheet = (
      <section
        className={`comment-sheet comment-sheet--${presentation}`}
        role={presentation === "sheet" ? "dialog" : "region"}
        aria-modal={presentation === "sheet" ? true : undefined}
        aria-labelledby="comment-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="comment-grabber" aria-hidden="true" />
        <header className="comment-header">
          <div>
            <h2 ref={titleRef} tabIndex={-1} id="comment-sheet-title">Kommentarer</h2>
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
  );

  return presentation === "inspector" ? sheet : (
    <div className="comment-backdrop" onClick={onClose}>{sheet}</div>
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
  presentation = "mobile",
  signedIn,
  libraryReady,
  onSignIn,
  followedPoliticians,
  followedParties,
  partyProfiles,
  personalizationAvailable,
  personalizationEnabled,
  onOpenForYou,
  onOpenLatest,
  onOpenSearch,
  onOpenProfile,
  onOpenLegal,
  onOpenPerson,
  onOpenParty,
  onTogglePerson,
  onToggleParty
}: {
  presentation?: "mobile" | "desktop";
  signedIn: boolean;
  libraryReady: boolean;
  onSignIn: () => void;
  followedPoliticians: string[];
  followedParties: PartyCode[];
  partyProfiles: PartyProfile[];
  personalizationAvailable: boolean;
  personalizationEnabled: boolean;
  onOpenForYou: () => void;
  onOpenLatest: () => void;
  onOpenSearch: () => void;
  onOpenProfile: () => void;
  onOpenLegal: (page: LegalPageId) => void;
  onOpenPerson: (personId: string) => void;
  onOpenParty: (party: PartyCode) => void;
  onTogglePerson: (personId: string) => void;
  onToggleParty: (party: PartyCode) => void;
}) {
  const [people, setPeople] = useState<Politician[]>([]);
  const [loading, setLoading] = useState(false);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const key = followedPoliticians.join(",");

  useEffect(() => {
    if (followedPoliticians.length === 0) {
      setPeople([]);
      setPeopleError(null);
      return;
    }
    let active = true;
    setLoading(true);
    setPeopleError(null);
    loadPoliticiansByIds(followedPoliticians)
      .then((rows) => active && setPeople(rows))
      .catch(() => {
        if (active) {
          setPeople([]);
          setPeopleError("Politikerna kunde inte hämtas. Försök igen om en stund.");
        }
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // `key` rather than the array itself: a new array identity on every render
    // would refetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const empty = followedParties.length === 0 && followedPoliticians.length === 0;

  if (presentation === "desktop") {
    const facts: DesktopFact[] = libraryReady
      ? [
          { label: "Partier", value: formatNumber(followedParties.length) },
          { label: "Politiker", value: formatNumber(followedPoliticians.length) }
        ]
      : [];

    return (
      <section className="panel-screen following-screen following-screen--desktop">
        <div className="panel-scroll desktop-following-scroll">
          <header className="desktop-following-hero">
            <div className="desktop-following-heading">
              <span className="desktop-profile-eyebrow">Mina val</span>
              <h1>Följer</h1>
              <p>Samla politiker och partier du vill följa på ett ställe.</p>
              {signedIn && <DesktopProfileFacts items={facts} />}
            </div>
            {signedIn && libraryReady && !empty && (
              <button
                className="desktop-action-primary desktop-following-open"
                type="button"
                onClick={onOpenForYou}
              >
                <Play size={16} aria-hidden="true" />
                <span>Öppna För dig</span>
              </button>
            )}
          </header>

          {!signedIn && (
            <div className="desktop-following-signed-out">
              <div className="desktop-following-explainer">
                <span className="desktop-following-kicker">Därför följer du</span>
                <h2>Dina val kan forma För dig</h2>
                <ul>
                  <li>
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <span>Politiker och partier du följer vägs in när personalisering är på.</span>
                  </li>
                  <li>
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <span>Valen hålls isär per konto på den här enheten.</span>
                  </li>
                  <li>
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <span>Ingenting används av För dig innan du själv aktiverar personalisering.</span>
                  </li>
                </ul>

                <div className="desktop-following-meanwhile">
                  <span>Under tiden</span>
                  <div>
                    <button type="button" onClick={onOpenLatest}>
                      <Play size={15} aria-hidden="true" />
                      Se senaste klippen
                    </button>
                    <button type="button" onClick={onOpenSearch}>
                      <Search size={15} aria-hidden="true" />
                      Sök politiker och partier
                    </button>
                  </div>
                </div>
              </div>

              <aside className="desktop-following-auth" aria-label="Logga in eller skapa konto">
                <DesktopSignInPanel onOpenLegal={onOpenLegal} onSignIn={onSignIn} />
              </aside>
            </div>
          )}

          {signedIn && !libraryReady && (
            <div className="desktop-following-loading" role="status">
              <LoaderCircle className="pwa-spinner" size={18} aria-hidden="true" />
              Hämtar dina följningar…
            </div>
          )}

          {signedIn && libraryReady && empty && (
            <div className="desktop-following-empty" role="status">
              <span className="desktop-following-kicker">Din lista är tom</span>
              <h2>Börja med en politiker eller ett parti</h2>
              <p>Följ från ett klipp eller hitta någon via sök. Dina val samlas sedan här.</p>
              <button className="desktop-action-primary" type="button" onClick={onOpenSearch}>
                <Search size={16} aria-hidden="true" />
                Öppna sök
              </button>
            </div>
          )}

          {signedIn && libraryReady && !empty && (
            <>
              {!personalizationEnabled && (
                <div className="desktop-following-notice" role="status">
                  <div>
                    <strong>Dina följningar påverkar inte För dig ännu</strong>
                    <span>
                      {personalizationAvailable
                        ? "Slå på personalisering i Profil när du vill använda listan i flödet."
                        : "Personalisering är inte tillgänglig just nu. Dina val ligger kvar på enheten."}
                    </span>
                  </div>
                  {personalizationAvailable && (
                    <button type="button" onClick={onOpenProfile}>Öppna Profil</button>
                  )}
                </div>
              )}

              <div
                className={`desktop-following-library${followedParties.length === 0 ? " has-no-parties" : ""}`}
              >
                <section className="desktop-following-region desktop-following-people">
                  <header>
                    <div>
                      <span>Personer</span>
                      <h2>Politiker du följer</h2>
                    </div>
                    <b>{formatNumber(followedPoliticians.length)}</b>
                  </header>
                  {loading && people.length === 0 && (
                    <div className="desktop-following-loading" role="status">
                      <LoaderCircle className="pwa-spinner" size={18} aria-hidden="true" />
                      Hämtar politiker…
                    </div>
                  )}
                  {peopleError && <p className="desktop-following-error" role="alert">{peopleError}</p>}
                  {!loading && !peopleError && followedPoliticians.length === 0 && (
                    <p className="desktop-following-region-empty">Du följer inga politiker ännu.</p>
                  )}
                  <div className="desktop-following-list">
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
                            className="desktop-unfollow"
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
                  </div>
                </section>

                {followedParties.length > 0 && (
                  <aside className="desktop-following-region desktop-following-parties">
                    <header>
                      <div>
                        <span>Partier</span>
                        <h2>Partier du följer</h2>
                      </div>
                      <b>{formatNumber(followedParties.length)}</b>
                    </header>
                    <div className="desktop-following-list">
                      {followedParties.map((partyCode) => {
                        const party = PARTIES[partyCode];
                        const logoUrl = partyProfiles.find(
                          (profile) => profile.abbr === partyCode
                        )?.logoUrl;
                        return (
                          <ListRow
                            key={partyCode}
                            avatar={<PartyAvatar party={partyCode} logoUrl={logoUrl} />}
                            title={party.name}
                            onClick={() => onOpenParty(partyCode)}
                            action={
                              <button
                                className="desktop-unfollow"
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
                    </div>
                  </aside>
                )}
              </div>
            </>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="panel-screen following-screen">
      <Header
        title="Följer"
        subtitle={`${followedParties.length} partier · ${followedPoliticians.length} personer`}
      />
      <div className="panel-scroll">
        {!signedIn && (
          <div className="panel-empty following-sign-in" role="status">
            <strong>Logga in för att se vilka du följer</strong>
            <span>Följningar kopplas till ditt konto och visas inte som anonym exempeldata.</span>
            <button type="button" className="account-button account-button--primary" onClick={onSignIn}>
              Logga in
            </button>
          </div>
        )}
        {signedIn && empty && (
          <div className="panel-empty" role="status">
            <strong>Du följer ingen ännu</strong>
            <span>Följ en politiker från ett klipp eller via sök, så samlas de här.</span>
          </div>
        )}
        {signedIn && (
        <div className="following-groups">
        {followedParties.length > 0 && (
          <Group title="Partier">
            {followedParties.map((partyCode) => {
              const party = PARTIES[partyCode];
              const logoUrl = partyProfiles.find(
                (profile) => profile.abbr === partyCode
              )?.logoUrl;
              return (
                <ListRow
                  key={partyCode}
                  avatar={<PartyAvatar party={partyCode} logoUrl={logoUrl} />}
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
/** One party can exceed 100 rows; 200 covers a full current Riksdag party. */
const PARTY_MEMBER_LIMIT = 200;

/**
 * The eight riksdag parties as one row of roll-downs.
 *
 * Desktop search used to ask for the party twice: eight letter chips in the
 * header and a `Riksdagspartier` list 550px further down, pointing at the same
 * eight parties while looking nothing alike — and the one carrying the
 * verified party mark and the whole name was the one below the fold. This is
 * that list's appearance, promoted to where the chips were, with the members
 * list the mobile party page has folded into each party: the party page, a
 * local name filter, then the politicians themselves.
 *
 * The list scrolls inside the panel because Socialdemokraterna has 107
 * politicians; a roll-down must not become a page.
 */
function DesktopPartyDirectory({
  profiles,
  loading,
  onOpenParty,
  onOpenPerson
}: {
  profiles: PartyProfile[];
  loading: boolean;
  onOpenParty: (profile: PartyProfile) => void;
  onOpenPerson: (politician: Politician) => void;
}) {
  const [openCode, setOpenCode] = useState<PartyCode | null>(null);
  const [memberQuery, setMemberQuery] = useState("");
  const [members, setMembers] = useState<Partial<Record<PartyCode, Politician[]>>>({});
  const [failedCode, setFailedCode] = useState<PartyCode | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const memberScrollRef = useRef<HTMLDivElement | null>(null);
  const triggersRef = useRef(new Map<PartyCode, HTMLButtonElement>());

  /** Fetch a party's politicians the first time its menu opens, then keep them. */
  useEffect(() => {
    if (openCode === null || members[openCode] !== undefined) {
      return;
    }
    let active = true;
    loadPoliticiansForParty(openCode, PARTY_MEMBER_LIMIT)
      .then((rows) => {
        if (active) {
          setMembers((current) => ({ ...current, [openCode]: rows }));
        }
      })
      .catch(() => {
        if (active) {
          setFailedCode(openCode);
        }
      });
    return () => {
      active = false;
    };
  }, [members, openCode]);

  /** A click anywhere else, or Escape, closes. Escape puts focus back. */
  useEffect(() => {
    if (openCode === null) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) {
        return;
      }
      setOpenCode(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        const trigger = triggersRef.current.get(openCode);
        setOpenCode(null);
        trigger?.focus();
        return;
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openCode]);

  /** Opening moves focus to the name filter so typing can begin immediately. */
  useEffect(() => {
    if (openCode === null) {
      return;
    }
    menuRef.current?.querySelector<HTMLInputElement>("[data-menu-search]")?.focus();
  }, [openCode]);

  /** A changed filter always starts at the top of its shorter result list. */
  useEffect(() => {
    memberScrollRef.current?.scrollTo({ top: 0 });
  }, [memberQuery, openCode]);

  // Only the first result joins the Tab order, so Tab does not walk hundreds
  // of names. The arrows still move through the complete filtered result.
  const moveMenuFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement && event.key !== "ArrowDown") {
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>("[data-member-item]") ?? []
    );
    if (items.length === 0) {
      return;
    }
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? Math.min(current + 1, items.length - 1)
            : Math.max(current - 1, 0);
    items[next]?.focus();
  };

  return (
    <section
      className="party-directory"
      ref={rootRef}
      aria-label="Riksdagspartier"
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && rootRef.current?.contains(next)) {
          return;
        }
        setOpenCode(null);
      }}
    >
      <div className="party-directory-head">
        <h2>Riksdagspartier</h2>
        <span>Öppna ett parti för partisidan och dess ledamöter</span>
      </div>
      {loading && profiles.length === 0 ? (
        <div className="party-directory-grid" role="status" aria-label="Hämtar partier">
          <span className="sr-only">Hämtar partier…</span>
          {Array.from({ length: 8 }, (_, index) => (
            <span className="party-directory-skeleton skeleton-shape" aria-hidden="true" key={index} />
          ))}
        </div>
      ) : (
        <div className="party-directory-grid">
          {profiles.map((profile) => {
            const open = openCode === profile.abbr;
            const panelId = `party-menu-${profile.abbr}`;
            const filterId = `${panelId}-member-filter`;
            const list = members[profile.abbr];
            const visibleMembers = list === undefined
              ? undefined
              : filterPartyMembers(list, memberQuery);
            const listFailed = failedCode === profile.abbr && list === undefined;
            const hasMemberQuery = memberQuery.trim().length > 0;
            const summary = [
              typeof profile.politicianCount === "number"
                ? `${formatNumber(profile.politicianCount)} ledamöter`
                : null,
              typeof profile.clipCount === "number"
                ? `${formatNumber(profile.clipCount)} klipp`
                : null
            ]
              .filter(Boolean)
              .join(" · ");

            return (
              <div className="party-directory-item" key={profile.abbr}>
                <button
                  type="button"
                  ref={(node) => {
                    if (node) {
                      triggersRef.current.set(profile.abbr, node);
                    } else {
                      triggersRef.current.delete(profile.abbr);
                    }
                  }}
                  className={open ? "party-directory-trigger is-open" : "party-directory-trigger"}
                  aria-expanded={open}
                  aria-haspopup="dialog"
                  aria-controls={panelId}
                  onClick={() => {
                    setMemberQuery("");
                    setFailedCode(null);
                    setOpenCode(open ? null : profile.abbr);
                  }}
                >
                  {/* The verified CDN mark, with the party-coloured letter as
                      the fallback — the same PartyAvatar the old list used. */}
                  <PartyAvatar party={profile.abbr} color={profile.color} logoUrl={profile.logoUrl} />
                  <span className="party-directory-name">{profile.name}</span>
                  {open ? (
                    <ChevronUp size={15} aria-hidden="true" />
                  ) : (
                    <ChevronDown size={15} aria-hidden="true" />
                  )}
                </button>

                {open && (
                  <div
                    className="party-menu"
                    id={panelId}
                    role="dialog"
                    aria-label={profile.name}
                    ref={menuRef}
                    onKeyDown={moveMenuFocus}
                  >
                    <div className="party-menu-head">
                      <PartyAvatar
                        party={profile.abbr}
                        color={profile.color}
                        logoUrl={profile.logoUrl}
                      />
                      <b>{profile.name}</b>
                      {summary && <span>{summary}</span>}
                    </div>

                    <div className="party-menu-actions">
                      <button
                        type="button"
                        className="party-menu-action"
                        onClick={() => {
                          setOpenCode(null);
                          onOpenParty(profile);
                        }}
                      >
                        <Home size={15} aria-hidden="true" />
                        Öppna partisidan
                        <ChevronRight className="party-menu-action-end" size={13} aria-hidden="true" />
                      </button>
                    </div>

                    <div className="party-menu-filter">
                      <label className="sr-only" htmlFor={filterId}>
                        Filtrera ledamöter i {profile.name}
                      </label>
                      <Search size={15} aria-hidden="true" />
                      <input
                        id={filterId}
                        type="search"
                        value={memberQuery}
                        data-menu-search=""
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="Sök namn"
                        onChange={(event) => setMemberQuery(event.target.value)}
                      />
                      {memberQuery && (
                        <button
                          type="button"
                          aria-label="Rensa namnfilter"
                          onClick={() => setMemberQuery("")}
                        >
                          <X size={13} aria-hidden="true" />
                        </button>
                      )}
                    </div>

                    <div className="party-menu-listhead">
                      <span>Ledamöter</span>
                      {list !== undefined && visibleMembers !== undefined && (
                        <i aria-live="polite">
                          {hasMemberQuery
                            ? `${formatNumber(visibleMembers.length)} av ${formatNumber(list.length)}`
                            : formatNumber(list.length)}
                        </i>
                      )}
                    </div>

                    <div className="party-menu-scroll" ref={memberScrollRef}>
                      {list === undefined && !listFailed && (
                        <div role="status" aria-label="Hämtar ledamöter">
                          <span className="sr-only">Hämtar ledamöter…</span>
                          {Array.from({ length: 4 }, (_, index) => (
                            <span
                              className="party-menu-skeleton skeleton-shape"
                              aria-hidden="true"
                              key={index}
                            />
                          ))}
                        </div>
                      )}
                      {listFailed && (
                        <p className="party-menu-message" role="status">
                          Ledamöterna kunde inte hämtas. Partisidan fungerar ändå.
                        </p>
                      )}
                      {list !== undefined && list.length === 0 && (
                        <p className="party-menu-message" role="status">
                          Inga registrerade ledamöter.
                        </p>
                      )}
                      {list !== undefined &&
                        list.length > 0 &&
                        visibleMembers?.length === 0 && (
                          <div className="party-menu-no-results" role="status">
                            <Search size={18} aria-hidden="true" />
                            <strong>Inga namn hittade</strong>
                            <span>Prova ett annat namn.</span>
                          </div>
                        )}
                      {visibleMembers?.map((politician, index) => {
                        const name = cleanName(politician.name) || politician.name;
                        const detail = [politician.role, politician.constituency]
                          .filter(Boolean)
                          .join(" · ");
                        return (
                          <button
                            type="button"
                            tabIndex={index === 0 ? 0 : -1}
                            data-member-item=""
                            className="party-menu-person"
                            key={politician.id}
                            onClick={() => {
                              setOpenCode(null);
                              onOpenPerson(politician);
                            }}
                          >
                            <Avatar
                              name={name}
                              party={politician.party}
                              size="sm"
                              imageUrl={politician.avatarUrl}
                            />
                            <b>{name}</b>
                            {detail && <small>{detail}</small>}
                            <ChevronRight size={12} aria-hidden="true" />
                          </button>
                        );
                      })}
                    </div>

                    {list !== undefined && list.length >= PARTY_MEMBER_LIMIT && (
                      <p className="party-menu-foot">
                        Visar de första {formatNumber(PARTY_MEMBER_LIMIT)}. Hela listan finns på
                        partisidan.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SearchScreen({
  presentation = "mobile",
  query,
  setQuery,
  partyFilter,
  setPartyFilter,
  partyProfiles,
  partyProfilesLoading,
  topicState,
  setTopicState,
  topicSearchAvailable,
  onOpenPerson,
  onOpenParty,
  onOpenTopicFeed
}: {
  presentation?: "mobile" | "desktop";
  query: string;
  setQuery: (query: string) => void;
  partyFilter: PartyCode | null;
  setPartyFilter: (party: PartyCode | null) => void;
  partyProfiles: PartyProfile[];
  partyProfilesLoading: boolean;
  topicState: TopicSearchState;
  setTopicState: Dispatch<SetStateAction<TopicSearchState>>;
  topicSearchAvailable: boolean;
  onOpenPerson: (personId: string) => void;
  onOpenParty: (party: PartyCode) => void;
  onOpenTopicFeed: (startId: string | null, scrollTop: number) => void;
}) {
  const [results, setResults] = useState<Politician[]>([]);
  const [searching, setSearching] = useState(false);
  const [resolvedSearchKey, setResolvedSearchKey] = useState<string | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const topicControllerRef = useRef<AbortController | null>(null);
  const topicRequestIdRef = useRef(0);
  const panelScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollRestoreRef = useRef<number | null>(topicState.scrollTop);
  const normalizedQuery = query.trim();
  const settledResponse =
    topicSearchAvailable && topicState.phase === "success" ? topicState.response : null;
  const responseMatchesInput =
    settledResponse !== null && topicState.submittedInput === normalizedQuery;
  const settledPersonFacet = responseMatchesInput
    ? settledResponse.interpretation.facets.find(
        (facet): facet is Extract<SearchFacet, { kind: "person" }> => facet.kind === "person"
      ) ?? null
    : null;
  const settledPartyFacet = responseMatchesInput
    ? settledResponse.interpretation.facets.find(
        (facet): facet is Extract<SearchFacet, { kind: "party" }> => facet.kind === "party"
      ) ?? null
    : null;
  const identityQuery = settledPersonFacet?.label ?? normalizedQuery;
  const identityPartyFilter = settledPartyFacet?.party ?? partyFilter;
  const showIdentityResults = identityQuery.length > 0 || identityPartyFilter !== null;
  const showResults =
    showIdentityResults || (topicSearchAvailable && topicState.phase !== "idle");
  const searchKey = `${identityPartyFilter ?? "ALL"}:${identityQuery.toLocaleLowerCase("sv-SE")}`;

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

  const stopTopicRequest = () => {
    topicRequestIdRef.current += 1;
    topicControllerRef.current?.abort();
    topicControllerRef.current = null;
  };

  const submitTopicSearch = (
    input = normalizedQuery,
    disabledFacets: readonly DisabledSearchFacet[] = topicState.disabledFacets,
    selectedParty = partyFilter
  ) => {
    if (!topicSearchAvailable) {
      rememberSearch(input);
      return;
    }

    const normalizedInput = input.trim();
    if (normalizedInput.length < 2 && selectedParty === null) {
      return;
    }
    const partyLabel = selectedParty
      ? partyProfiles.find((profile) => profile.abbr === selectedParty)?.name ??
        PARTIES[selectedParty].name
      : null;
    const requestQuery = buildTopicRequestQuery(normalizedInput, selectedParty, partyLabel);
    if (requestQuery.length < 2) {
      return;
    }

    panelScrollRef.current?.scrollTo({ top: 0 });
    stopTopicRequest();
    const requestId = topicRequestIdRef.current;
    const controller = new AbortController();
    topicControllerRef.current = controller;
    rememberSearch(normalizedInput || partyLabel || requestQuery);
    setTopicState((current) =>
      beginTopicSearch(current, normalizedInput, requestQuery, disabledFacets)
    );

    searchPublishedTopics(
      {
        query: requestQuery,
        limit: TOPIC_SEARCH_RESULT_LIMIT,
        ...(disabledFacets.length > 0 ? { disabledFacets: [...disabledFacets] } : {})
      },
      controller.signal
    )
      .then((response) => {
        if (!controller.signal.aborted && topicRequestIdRef.current === requestId) {
          setTopicState((current) => completeTopicSearch(current, response));
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || topicRequestIdRef.current !== requestId) {
          return;
        }
        const kind = error instanceof TopicSearchApiError ? error.kind : "network";
        setTopicState((current) => failTopicSearch(current, kind));
      })
      .finally(() => {
        if (topicRequestIdRef.current === requestId) {
          topicControllerRef.current = null;
        }
      });
  };

  const removeFacet = (facet: SearchFacet) => {
    if (facet.kind === "topic") {
      stopTopicRequest();
      const facets = topicState.response?.interpretation.facets ?? [];
      setQuery(identityQueryAfterTopicRemoval(facets));
      setPartyFilter(partyAfterTopicRemoval(facets));
      setTopicState(EMPTY_TOPIC_SEARCH_STATE);
      return;
    }

    const disabledFacets = addDisabledFacet(topicState.disabledFacets, facet.kind);
    const selectedParty = facet.kind === "party" ? null : partyFilter;
    if (facet.kind === "party") {
      setPartyFilter(null);
      if (!topicState.submittedInput.trim()) {
        stopTopicRequest();
        setTopicState(EMPTY_TOPIC_SEARCH_STATE);
        return;
      }
    }
    submitTopicSearch(topicState.submittedInput, disabledFacets, selectedParty);
  };

  const chooseAmbiguity = (option: SearchAmbiguityOption) => {
    setQuery(option.label);
    setPartyFilter(null);
    submitTopicSearch(option.label, [], null);
  };

  useEffect(
    () => () => {
      topicControllerRef.current?.abort();
    },
    []
  );
  const matchingParties = useMemo(() => {
    if (identityPartyFilter && identityPartyFilter !== "NONE") {
      return partyProfiles.filter((profile) => profile.abbr === identityPartyFilter);
    }
    const term = identityQuery.toLocaleLowerCase("sv-SE");
    if (!term) {
      return [];
    }
    return partyProfiles.filter((profile) =>
      [profile.abbr, profile.name, profile.short]
        .some((value) => value.toLocaleLowerCase("sv-SE").includes(term))
    );
  }, [identityPartyFilter, identityQuery, partyProfiles]);

  const resultCount = matchingParties.length + results.length;
  const searchPending =
    showIdentityResults &&
    (partyProfilesLoading || searching || resolvedSearchKey !== searchKey);

  useLayoutEffect(() => {
    const scrollTop = pendingScrollRestoreRef.current;
    if (searchPending || scrollTop === null || panelScrollRef.current === null) {
      return;
    }
    panelScrollRef.current.scrollTop = scrollTop;
    pendingScrollRestoreRef.current = null;
  }, [searchPending]);

  useEffect(() => {
    if (!showIdentityResults) {
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
      searchPoliticians(identityQuery, {
        party: identityPartyFilter,
        signal: controller.signal
      })
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
  }, [identityPartyFilter, identityQuery, searchKey, showIdentityResults]);

  return (
    <section
      className={`${showResults ? "panel-screen search-screen has-results" : "panel-screen search-screen"}${presentation === "desktop" ? " search-screen--desktop" : ""}`}
    >
      <div className="search-header">
        {(!showResults || presentation === "desktop") && <h1>Sök</h1>}
        <form
          className="search-form"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            submitTopicSearch();
          }}
        >
          <div className="search-box">
            <Search size={18} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Sök person, parti eller ämne"
              placeholder="Sök person, parti eller ämne"
            />
            {query.length > 0 && (
              <button
                type="button"
                className="search-clear"
                onClick={() => {
                  stopTopicRequest();
                  setQuery("");
                  setTopicState(EMPTY_TOPIC_SEARCH_STATE);
                }}
                aria-label="Rensa sökningen"
              >
                <X size={13} />
              </button>
            )}
            {topicSearchAvailable && (
              <button
                type="submit"
                className="search-submit"
                disabled={normalizedQuery.length < 2 && partyFilter === null}
                aria-label="Sök i klippen"
              >
                Sök
              </button>
            )}
          </div>
        </form>
        {topicSearchAvailable && (
          <p className="topic-search-privacy-note">
            Ämnessökningar tolkas med hjälp av OpenAI. Skriv inte privat information.
          </p>
        )}
        {/* On desktop the eight roll-downs own the landing state, so this
            compact row appears only once there are results to filter. The two
            are the same control at two sizes and never share the screen. */}
        {(presentation !== "desktop" || showResults) && (
          <div className="chips" aria-label="Filtrera på parti">
            <button
              type="button"
              className={partyFilter === null ? "chips-home active" : "chips-home"}
              onClick={() => setPartyFilter(null)}
              aria-label="Visa alla partier"
            >
              {presentation === "desktop" ? (
                <span>Alla partier</span>
              ) : (
                <Home size={17} aria-hidden="true" />
              )}
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
        )}
        {settledResponse && (
          <SearchInterpretation
            facets={settledResponse.interpretation.facets}
            onRemove={removeFacet}
          />
        )}
      </div>
      <div
        className="panel-scroll"
        ref={panelScrollRef}
        aria-busy={searchPending || topicState.phase === "loading" || undefined}
      >
        {showResults ? (
          <div className="search-results" aria-live="polite">
            {searchPending ? (
              <SearchResultsSkeleton />
            ) : (
              <>
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
                      <PartyAvatar
                        party={profile.abbr}
                        color={profile.color}
                        logoUrl={profile.logoUrl}
                      />
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
                {!topicSearchAvailable && resultCount === 0 && (
                  <div className="panel-empty" role="status">
                    <strong>Inga träffar</strong>
                    <span>Sök på en politikers namn, eller filtrera på parti.</span>
                  </div>
                )}
              </>
            )}

            {topicSearchAvailable && topicState.phase === "loading" && (
              <TopicSearchResultsSkeleton />
            )}
            {topicSearchAvailable && topicState.phase === "error" && (
              <section className="topic-search-message" role="alert">
                <strong>Klippsökningen pausades</strong>
                <p>{topicSearchErrorMessage(topicState.errorKind)}</p>
                <button type="button" onClick={() => submitTopicSearch(topicState.submittedInput)}>
                  Försök igen
                </button>
              </section>
            )}
            {settledResponse && (
              <TopicSearchResults
                response={settledResponse}
                revealedCount={topicState.revealedCount}
                onRevealMore={() => setTopicState(revealMoreTopicResults)}
                onChooseAmbiguity={chooseAmbiguity}
                onPlay={(startId) =>
                  onOpenTopicFeed(startId, panelScrollRef.current?.scrollTop ?? 0)
                }
              />
            )}
            {topicSearchAvailable &&
              topicState.phase === "idle" &&
              !searchPending &&
              resultCount === 0 && (
                <div className="panel-empty topic-search-idle" role="status">
                  <strong>Inga personer eller partier</strong>
                  <span>Tryck på Sök för att leta efter relevanta klipp.</span>
                </div>
              )}
          </div>
        ) : (
          <>
            {presentation === "desktop" && (
              <DesktopPartyDirectory
                profiles={partyProfiles}
                loading={partyProfilesLoading}
                onOpenParty={openParty}
                onOpenPerson={openPerson}
              />
            )}
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
            {presentation === "mobile" && (
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
            )}
          </>
        )}
      </div>
    </section>
  );
}

function SearchInterpretation({
  facets,
  onRemove
}: {
  facets: readonly SearchFacet[];
  onRemove: (facet: SearchFacet) => void;
}) {
  const sorted = sortedSearchFacets(facets);
  if (sorted.length === 0) {
    return null;
  }
  return (
    <div className="search-interpretation" aria-label="Tolkat som">
      <span>Tolkat som</span>
      <div>
        {sorted.map((facet) => (
          <span className="search-facet" key={`${facet.kind}:${facet.label}`}>
            {visibleFacetLabel(facet)}
            <button
              type="button"
              onClick={() => onRemove(facet)}
              aria-label={`Ta bort ${visibleFacetLabel(facet)} och bredda sökningen`}
            >
              <X size={11} aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

function TopicSearchResults({
  response,
  revealedCount,
  onRevealMore,
  onChooseAmbiguity,
  onPlay
}: {
  response: NonNullable<TopicSearchState["response"]>;
  revealedCount: number;
  onRevealMore: () => void;
  onChooseAmbiguity: (option: SearchAmbiguityOption) => void;
  onPlay: (startId: string | null) => void;
}) {
  const visibleResults = response.results.slice(0, revealedCount);
  const remaining = response.results.length - visibleResults.length;
  const ambiguity = response.interpretation.ambiguity;

  return (
    <div className="topic-search-results">
      {ambiguity && (
        <section className="search-ambiguity" aria-labelledby="search-ambiguity-title">
          <span className="search-kicker">Välj {ambiguity.kind === "person" ? "person" : "händelse"}</span>
          <h2 id="search-ambiguity-title">{ambiguity.message}</h2>
          <div>
            {ambiguity.options.map((option) => (
              <button type="button" key={option.id} onClick={() => onChooseAmbiguity(option)}>
                <span>{option.label}</span>
                <small>{option.detail}</small>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      )}

      {response.event && <SearchEventDestination event={response.event} />}

      {response.mode === "keyword_fallback" && (
        <div className="topic-search-fallback" role="status">
          Visar ordträffar just nu. Politiker, partier och filter fungerar som vanligt.
        </div>
      )}

      {response.dateBroadening && (
        <div className="topic-search-relaxation" role="status">
          {dateBroadeningNotice(response.dateBroadening)}
        </div>
      )}

      <section className="topic-clip-section" aria-labelledby="topic-result-heading">
        <div className="topic-result-heading">
          <div>
            <h2 id="topic-result-heading">
              {topicResultHeading(response.interpretation.facets)}
            </h2>
            <p>
              Mest relevanta först · {response.results.length}{" "}
              {response.results.length === 1 ? "träff" : "träffar"}
            </p>
          </div>
          {response.results.length > 0 && (
            <button type="button" className="topic-show-more" onClick={() => onPlay(null)}>
              Spela alla
            </button>
          )}
        </div>

        {visibleResults.length > 0 ? (
          <div className="topic-result-list">
            {visibleResults.map((result) => (
              <TopicClipResultRow
                result={result}
                key={result.clip.id}
                onPlay={() => onPlay(result.clip.id)}
              />
            ))}
          </div>
        ) : (
          <div className="topic-search-empty" role="status">
            <strong>Inga relevanta klipp hittades</strong>
            <span>Ta bort ett filter eller prova en bredare svensk formulering.</span>
          </div>
        )}

        {remaining > 0 && (
          <button type="button" className="topic-show-more" onClick={onRevealMore}>
            Visa {Math.min(20, remaining)} till
          </button>
        )}
      </section>
    </div>
  );
}

function SearchEventDestination({
  event
}: {
  event: NonNullable<NonNullable<TopicSearchState["response"]>["event"]>;
}) {
  const content = (
    <>
      <span className="search-event-mark" aria-hidden="true">
        <Play size={14} fill="currentColor" />
      </span>
      <span>
        <small>Verifierad riksdagshändelse</small>
        <strong>{event.label}</strong>
        <span>
          {event.dateLabel} · {event.clipCount} klipp
        </span>
      </span>
      <ArrowUpRight size={17} aria-hidden="true" />
    </>
  );
  return (
    <section className="search-event-section" aria-label="Händelse">
      <span className="search-kicker">Händelse</span>
      {event.sourceUrl ? (
        <a href={event.sourceUrl} target="_blank" rel="noreferrer" className="search-event-row">
          {content}
        </a>
      ) : (
        <div className="search-event-row">{content}</div>
      )}
    </section>
  );
}

function TopicClipResultRow({
  result,
  onPlay
}: {
  result: SearchClipResult;
  onPlay: () => void;
}) {
  const party = PARTIES[result.partyAtSpeech];
  return (
    <article className="topic-result-row"
      aria-labelledby={`topic-title-${result.clip.id}`}
      role="link"
      tabIndex={0}
      onClick={onPlay}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onPlay();
        }
      }}
    >
      <div className="topic-result-thumb">
        <img src={result.clip.thumbUrl} alt="" loading="lazy" />
        <span>{formatDuration(result.clip.durationS)}</span>
      </div>
      <div className="topic-result-copy">
        <h3 id={`topic-title-${result.clip.id}`}>{result.clip.title}</h3>
        <div className="topic-result-byline">
          <i style={{ background: party.color }} aria-hidden="true" />
          <span>{result.speakerNameAtSpeech}</span>
          <b>· {result.partyAtSpeech === "NONE" ? "Partilös" : result.partyAtSpeech}</b>
        </div>
        <div className="topic-result-source">
          {formatDate(result.clip.debateDate)} · {result.clip.sourceTitle}
        </div>
        <p>“{result.matchExcerpt}”</p>
      </div>
    </article>
  );
}

function TopicSearchResultsSkeleton() {
  return (
    <div className="topic-results-skeleton" role="status" aria-label="Söker i klippen">
      <div className="topic-search-loading">
        <LoaderCircle className="topic-search-spinner" size={18} aria-hidden="true" />
        <span>Söker efter relevanta klipp…</span>
      </div>
      {Array.from({ length: 3 }, (_, index) => (
        <div className="topic-skeleton-row" aria-hidden="true" key={index}>
          <span className="skeleton-shape" />
          <div>
            <span className="skeleton-shape" />
            <span className="skeleton-shape" />
            <span className="skeleton-shape" />
          </div>
        </div>
      ))}
    </div>
  );
}

function LegalScreen({
  presentation = "mobile",
  page,
  onBack,
  onNavigate,
  onOpenCookieSettings
}: {
  presentation?: "mobile" | "desktop";
  page: LegalPageId;
  onBack: () => void;
  onNavigate: (page: LegalPageId) => void;
  onOpenCookieSettings: () => void;
}) {
  const document = LEGAL_PAGES[page];
  return (
    <section className={presentation === "desktop" ? "panel-screen legal-screen legal-screen--desktop" : "panel-screen legal-screen"}>
      <header className="legal-topbar">
        <button type="button" className={presentation === "desktop" ? "desktop-back-action" : undefined} aria-label="Tillbaka till Profil" onClick={onBack}>
          <ChevronLeft size={20} />
          {presentation === "desktop" && <span>Tillbaka till Profil</span>}
        </button>
        <span>Juridisk information</span>
      </header>
      <div className="legal-scroll">
        <header className="legal-intro">
          <span className="legal-kicker">Pleni</span>
          <h1>{document.title}</h1>
          <p>{document.summary}</p>
          <time dateTime={LEGAL_VERSION}>Gäller från 4 september 2026 · version {LEGAL_VERSION}</time>
          {page === "storage" && (
            <button type="button" className="legal-cookie-settings" onClick={onOpenCookieSettings}>
              Ändra analysinställningar
            </button>
          )}
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
  presentation = "mobile",
  signedIn,
  consent,
  analyticsChoice,
  onOpenAnalyticsSettings,
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
  presentation?: "mobile" | "desktop";
  signedIn: boolean;
  consent: { personal: boolean; analytics: boolean; email: boolean };
  analyticsChoice: AnalyticsConsentChoice | null;
  onOpenAnalyticsSettings: () => void;
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
  // Every group is built once and composed twice. The phone stacks them in the
  // released order; desktop splits them into what you use and what is yours.
  const accountRows = (
    <>
      {/* These counts used to be invented ("Sparade klipp 24"). They are now
          the real length of the device-local library — see
          `library-store.ts`. Still not server-side: that is `C-9`, gated on
          F1. */}
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
    </>
  );

  const installGroup = pwa.installKind ? (
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
  ) : null;

  const interestsRow = (
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
  );

  const consentGroupRows = (
    <>
      {consentRows.map((row) => (
        <ListRow
          key={row.key}
          title={row.title}
          subtitle={row.help}
          action={<Switch checked={consent[row.key]} onChange={() => onToggleConsent(row.key)} />}
        />
      ))}
      {recommendationError && (
        <div className="recommendation-error" role="alert">
          {recommendationError}
        </div>
      )}
    </>
  );

  const analyticsGroup = (
    <Group title="Integritet">
      <ListRow
        title="Analys och cookies"
        subtitle={
          analyticsChoice === "granted"
            ? "Analys är tillåten · ändra eller återkalla när du vill"
            : analyticsChoice === "denied"
              ? "Endast nödvändiga · ändra ditt val när du vill"
              : "Inget val gjort · Google Analytics är inte laddat"
        }
        icon={<BarChart3 size={18} />}
        onClick={onOpenAnalyticsSettings}
        chevron
      />
    </Group>
  );

  const recommendationRows = recommendationsConnected ? (
    <>
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
      {/* The only thing on this page that cannot be undone. It must not look
          like the export row above it. */}
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
        tone={presentation === "desktop" ? "danger" : undefined}
        onClick={recommendationAction ? undefined : onDeleteRecommendationData}
        chevron={!recommendationAction}
      />
      {recommendationActionMessage && (
        <div className="recommendation-success" role="status">
          {recommendationActionMessage}
        </div>
      )}
    </>
  ) : null;

  const legalLinks = (
    <nav className="profile-legal-links" aria-label="Juridisk information">
      {LEGAL_PAGE_ORDER.map((page) => (
        <button key={page} type="button" onClick={() => onOpenLegal(page)}>
          {LEGAL_PAGES[page].shortTitle}
        </button>
      ))}
    </nav>
  );

  const versionLine = <div className="version">Pleni 1.0 · data från riksdagen.se</div>;

  if (presentation === "desktop") {
    return (
      <section className="panel-screen profile-screen profile-screen--desktop">
        <div className="panel-scroll desktop-account-scroll">
          <header className="desktop-account-band">
            <div className="desktop-account-band-inner">
              <div className="desktop-account-identity">
                {clerkEnabled && signedIn ? (
                  <DesktopAccountIdentity />
                ) : (
                  <>
                    <h1>Profil</h1>
                    <p className="desktop-account-lede">
                      Konto, personalisering och integritet. Flödet, sök och uppspelning
                      fungerar utan konto — kontot behövs för att följa, spara och gilla.
                    </p>
                  </>
                )}
                {/* Counts only when there is an account they belong to. Signed
                    out we have not read a library, and zero would be a claim. */}
                {signedIn && (
                  <dl className="desktop-account-facts">
                    <div>
                      <dt>Sparade klipp</dt>
                      <dd>{formatNumber(savedCount)}</dd>
                    </div>
                    <div>
                      <dt>Följer</dt>
                      <dd>{formatNumber(totalFollowed)}</dd>
                    </div>
                  </dl>
                )}
              </div>
              {clerkEnabled && signedIn && <DesktopAccountActions />}
            </div>
          </header>

          <div className="desktop-account-body">
            <div className="desktop-account-main">
              {signedIn && <Group title="Ditt innehåll">{accountRows}</Group>}
              <Group title={signedIn ? "Personalisering" : "Fungerar utan konto"}>
                {interestsRow}
                {consentGroupRows}
              </Group>
              {installGroup}
              {!signedIn && !clerkEnabled && (
                <AccountCard signedIn={signedIn} onOpenLegal={onOpenLegal} />
              )}
            </div>

            <aside className="desktop-account-rail">
              {!signedIn && clerkEnabled && (
                <DesktopSignInPanel onOpenLegal={onOpenLegal} />
              )}
              {analyticsGroup}
              {/* Export, reset and delete act on a recommendation profile keyed
                  to a Clerk account. Signed out there is nothing to act on, so
                  the group is not offered — `recommendationsConnected` is a
                  build flag, not a session. */}
              {signedIn && recommendationRows && (
                <Group title="Dina data">
                  {recommendationRows}
                  <p className="profile-danger-note">
                    Radering går inte att ångra. Ditt konto, dina sparade klipp och dina
                    följningar rörs inte.
                  </p>
                </Group>
              )}
              <div className="profile-legal-group">
                <Group title="Villkor och information">
                  {LEGAL_PAGE_ORDER.map((page) => (
                    <ListRow
                      key={page}
                      title={LEGAL_PAGES[page].shortTitle}
                      onClick={() => onOpenLegal(page)}
                      chevron
                    />
                  ))}
                </Group>
              </div>
            </aside>
          </div>

          {versionLine}
        </div>
      </section>
    );
  }

  return (
    <section className="panel-screen profile-screen">
      <Header title="Profil" />
      <div className="panel-scroll">
        <AccountCard signedIn={signedIn} onOpenLegal={onOpenLegal} />
        <Group title="Konto">{accountRows}</Group>
        {installGroup}
        <Group title="Mina intressen">{interestsRow}</Group>
        <Group title="Personalisering">{consentGroupRows}</Group>
        {analyticsGroup}
        {recommendationRows && (
          <Group title="Mina rekommendationsdata">{recommendationRows}</Group>
        )}
        {legalLinks}
        {versionLine}
      </div>
    </section>
  );
}

/**
 * Who is signed in, in Pleni's own type rather than Clerk's widget.
 *
 * The portrait still comes from Clerk (`user.imageUrl`); only the frame around
 * it is ours. `<UserButton>` drew its own avatar, its own menu and its own
 * typography in the middle of a page that is otherwise this product's.
 */
function DesktopAccountIdentity() {
  const { user } = useClerk();
  const displayName = user?.fullName ?? user?.username ?? "Ditt konto";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const imageUrl = user?.imageUrl ?? null;

  return (
    <div className="desktop-account-who">
      <span className="desktop-account-avatar" aria-hidden="true">
        {imageUrl ? <img src={imageUrl} alt="" /> : <span>{initials(displayName)}</span>}
      </span>
      <h1>{displayName}</h1>
      {email && <p className="desktop-account-email">{email}</p>}
    </div>
  );
}

/**
 * Manage and sign out. Neither is a primary action: this page's job is not to
 * send the viewer somewhere, and the only candidate would have been sign-out.
 *
 * Account management itself stays Clerk's — email, password and MFA are its
 * responsibility — but it opens from our own control rather than from a Clerk
 * avatar embedded in the layout.
 */
function DesktopAccountActions() {
  const clerk = useClerk();

  return (
    <div className="desktop-account-actions">
      <button
        type="button"
        className="desktop-account-button"
        onClick={() => clerk.openUserProfile()}
      >
        <Sliders size={15} aria-hidden="true" />
        Hantera konto
      </button>
      <SignOutButton>
        <button type="button" className="desktop-account-button is-quiet">
          Logga ut
        </button>
      </SignOutButton>
    </div>
  );
}

/**
 * The same sign-in module the desktop Följer page uses. One component, two
 * pages, so "you need an account" reads the same wherever it appears.
 */
function DesktopSignInPanel({
  onOpenLegal,
  onSignIn
}: {
  onOpenLegal: (page: LegalPageId) => void;
  onSignIn?: () => void;
}) {
  return (
    <div className="desktop-signin-panel">
      <span className="desktop-signin-mark" aria-hidden="true">
        <UserRound size={22} />
      </span>
      <h2>Logga in för att spara och följa</h2>
      <p>
        Sparade klipp, följningar och gillningar hör till kontot. Utan konto fungerar
        flödet, sök och uppspelning precis som vanligt.
      </p>
      {onSignIn ? (
        <button
          type="button"
          className="desktop-account-button is-primary"
          disabled={!clerkEnabled}
          onClick={onSignIn}
        >
          Logga in
        </button>
      ) : (
        <SignInButton mode="modal">
          <button type="button" className="desktop-account-button is-primary">
            Logga in
          </button>
        </SignInButton>
      )}
      {clerkEnabled ? (
        <SignUpButton mode="modal">
          <button type="button" className="desktop-account-button">
            Skapa konto
          </button>
        </SignUpButton>
      ) : (
        <button type="button" className="desktop-account-button" disabled>
          Skapa konto
        </button>
      )}
      <p className="desktop-signin-foot">
        Genom att skapa konto godkänner du{" "}
        <button type="button" onClick={() => onOpenLegal("terms")}>
          användarvillkoren
        </button>
        . Läs hur vi hanterar personuppgifter under{" "}
        <button type="button" onClick={() => onOpenLegal("privacy")}>
          integritet
        </button>
        . Är du under 13 år behöver du din vårdnadshavares tillstånd.
      </p>
    </div>
  );
}

/**
 * Identity block at the top of the Profil tab.
 *
 * Three states: Clerk not configured, signed out, signed in. The anonymous
 * `Senaste` feed works in all three — signing in is never required to watch.
 */
function AccountCard({
  signedIn,
  onOpenLegal
}: {
  signedIn: boolean;
  onOpenLegal: (page: LegalPageId) => void;
}) {
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

  if (signedIn) {
    return <SignedInAccountCard />;
  }

  return (
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
  );
}

function SignedInAccountCard() {
  const { user } = useClerk();
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
  presentation = "mobile",
  scrollKey = null,
  clips,
  loading,
  error,
  onBack,
  onPlayClip
}: {
  presentation?: "mobile" | "desktop";
  scrollKey?: string | null;
  clips: ClipItem[];
  loading: boolean;
  error: string | null;
  onBack: () => void;
  onPlayClip: (clipId: string) => void;
}) {
  const { scrollRef, rememberScroll } = useProfileScrollPosition(
    scrollKey,
    presentation === "desktop"
  );
  const playClip = (clipId: string) => {
    if (presentation === "desktop" && scrollKey && scrollRef.current) {
      desktopProfileScrollPositions.write(scrollKey, scrollRef.current.scrollTop);
    }
    onPlayClip(clipId);
  };
  return (
    <section className={presentation === "desktop" ? "person-screen saved-screen saved-screen--desktop" : "person-screen saved-screen"}>
      <div className={presentation === "desktop" ? "desktop-profile-toolbar" : "person-topbar"}>
        <button className={presentation === "desktop" ? "desktop-back-action" : undefined} onClick={onBack} aria-label="Tillbaka">
          <ChevronLeft size={24} />
          {presentation === "desktop" && <span>Tillbaka till Profil</span>}
        </button>
        {presentation === "desktop" && <h1>Sparade klipp</h1>}
        {presentation === "mobile" && <strong>Sparade klipp</strong>}
        {presentation === "mobile" && <span className="person-topbar-spacer" aria-hidden="true" />}
      </div>
      <div ref={scrollRef} className="panel-scroll person-scroll" onScroll={rememberScroll}>
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
                  onClick={() => playClip(clip.id)}
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

const desktopProfileScrollPositions = createScrollMemory();

/**
 * How many politicians a profile side column lists before it collapses.
 *
 * Both desktop profile routes can expand the full membership in a bounded
 * internal scroll region without stretching the outer document.
 */
const RAIL_PERSON_LIMIT = 6;

/** Three rows of three: what the gallery frame shows before it scrolls. */
const GALLERY_VISIBLE_TILES = 9;

function useProfileScrollPosition(scrollKey: string | null, enabled: boolean) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!enabled || !scrollKey || !element) {
      return;
    }
    const position = desktopProfileScrollPositions.read(scrollKey);
    const frame = window.requestAnimationFrame(() => {
      element.scrollTop = position;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [enabled, scrollKey]);

  const rememberScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (enabled && scrollKey) {
        desktopProfileScrollPositions.write(scrollKey, event.currentTarget.scrollTop);
      }
    },
    [enabled, scrollKey]
  );

  return { scrollRef, rememberScroll };
}

/**
 * Context bar for a desktop profile route.
 *
 * Replaces the 78px toolbar that carried nothing but a Back button. A profile
 * is not one of the four tabs, so the breadcrumb — not a lit sidebar item —
 * is what says where the viewer is.
 */
function DesktopProfileBar({
  kind,
  name,
  onBack
}: {
  kind: string;
  name: string;
  onBack: () => void;
}) {
  return (
    <div className="desktop-profile-bar">
      <button className="desktop-profile-back" type="button" onClick={onBack}>
        <ChevronLeft size={16} aria-hidden="true" />
        <span>Tillbaka</span>
      </button>
      <nav className="desktop-profile-crumbs" aria-label="Var du är">
        <span>{kind}</span>
        <ChevronRight size={13} aria-hidden="true" />
        <b>{name}</b>
      </nav>
    </div>
  );
}

type DesktopFact = { label: string; value: string; text?: boolean };

/**
 * The masthead fact strip.
 *
 * Callers pass only facts they actually read from the catalogue. A count that
 * could not be fetched is `null` upstream and never reaches this list, so an
 * unknown total renders as absent rather than as zero (`Q-2`, and the UI20
 * rule against invented figures).
 */
function DesktopProfileFacts({ items }: { items: DesktopFact[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <dl className="desktop-profile-facts">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd className={item.text ? "is-text" : undefined}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One labelled row in a profile side column. */
function DesktopRailFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="desktop-rail-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A politician row in a profile side column. */
function DesktopRailPerson({
  politician,
  detail,
  onOpen
}: {
  politician: Politician;
  detail: string;
  onOpen: () => void;
}) {
  const name = cleanName(politician.name) || politician.name;
  return (
    <button className="desktop-rail-person" type="button" onClick={onOpen}>
      <Avatar name={name} party={politician.party} size="sm" imageUrl={politician.avatarUrl} />
      <b>{name}</b>
      {detail && <small>{detail}</small>}
      <ChevronRight size={13} aria-hidden="true" />
    </button>
  );
}

/**
 * The clip gallery on a desktop profile page.
 *
 * The newest clip leads with its full sentence — desktop has room for the line
 * that the mobile card truncates mid-word — and the rest sit in a three-up
 * grid inside its own scroll frame, so the masthead and side column stay put
 * while the viewer browses. The frame's height comes from an aspect ratio
 * rather than a pixel value, which keeps three whole rows visible and a sliver
 * of the fourth at every desktop width.
 */
function DesktopClipGallery({
  clips,
  loading,
  total,
  hasMore,
  loadingMore,
  pageError,
  emptyTitle,
  emptyDetail,
  captionFor,
  leadMeta,
  onPlayClip,
  onLoadMore
}: {
  clips: ClipItem[];
  loading: boolean;
  total: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  pageError: string | null;
  emptyTitle: string;
  emptyDetail: string;
  captionFor: (clip: ClipItem) => string;
  leadMeta: (clip: ClipItem) => ReactNode;
  onPlayClip: (clipId: string | null) => void;
  onLoadMore: () => void;
}) {
  const [lead, ...rest] = clips;
  // The frame reserves three rows' worth of height. Below a fourth row there
  // is nothing to scroll to, so a short catalogue renders a plain grid rather
  // than a tall box with empty space under it.
  const scrolls = rest.length > GALLERY_VISIBLE_TILES;

  return (
    <section className="desktop-clip-gallery">
      <div className="desktop-section-head">
        <h2>Senaste klipp</h2>
        {typeof total === "number" && (
          <span className="desktop-section-count">{formatNumber(total)} publicerade</span>
        )}
        {clips.length > 1 && <span className="desktop-section-order">Nyast först</span>}
      </div>

      {loading && clips.length === 0 && <ClipGridSkeleton />}
      {!loading && clips.length === 0 && (
        <div className="panel-empty" role="status">
          <strong>{emptyTitle}</strong>
          <span>{emptyDetail}</span>
        </div>
      )}

      {lead && (
        <article className="desktop-lead-clip">
          <button
            className="mini-clip desktop-lead-thumb"
            type="button"
            onClick={() => onPlayClip(lead.id)}
            aria-label={`Spela: ${lead.title}`}
          >
            <img src={lead.thumbUrl} alt="" loading="lazy" />
            <span className="mini-clip-duration">{formatDuration(lead.durationS)}</span>
          </button>
          <div className="desktop-lead-copy">
            <span className="desktop-lead-kicker">Senaste klippet</span>
            {/* The full sentence, not the 55-character `title` the mobile card
                shows — the truncation exists for a 9:16 overlay, not for a
                746px column. */}
            <h3>{lead.transcript || lead.title}</h3>
            <div className="desktop-lead-meta">{leadMeta(lead)}</div>
            <button className="desktop-lead-play" type="button" onClick={() => onPlayClip(lead.id)}>
              <Play size={13} aria-hidden="true" />
              Spela klippet
            </button>
          </div>
        </article>
      )}

      {rest.length > 0 && (
        <div className={scrolls ? "desktop-gallery-frame" : undefined}>
          <div className={scrolls ? "desktop-gallery-scroll" : undefined}>
            <div className="clip-grid">
              {rest.map((clip) => (
                <button
                  className="mini-clip"
                  key={clip.id}
                  type="button"
                  onClick={() => onPlayClip(clip.id)}
                  aria-label={`Spela: ${clip.title}`}
                >
                  <img src={clip.thumbUrl} alt="" loading="lazy" />
                  <span className="mini-clip-duration">{formatDuration(clip.durationS)}</span>
                  <span className="mini-clip-copy">
                    <b>{clip.title}</b>
                    {/* Q-8: every clip shows its debate date, here as well as
                        in the feed. Target for "old content without a visible
                        date" is exactly zero. */}
                    <small>{captionFor(clip)}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {clips.length > 0 && (
        <div className="desktop-gallery-foot">
          <span>
            {typeof total === "number"
              ? `Visar ${formatNumber(clips.length)} av ${formatNumber(total)} klipp`
              : `Visar ${formatNumber(clips.length)} klipp`}
          </span>
          {hasMore && (
            <button
              className="desktop-gallery-more"
              type="button"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              {loadingMore && <LoaderCircle className="pwa-spinner" size={15} aria-hidden="true" />}
              {loadingMore ? "Hämtar fler…" : "Hämta fler klipp"}
            </button>
          )}
        </div>
      )}
      {pageError && <p className="desktop-gallery-page-error" role="alert">{pageError}</p>}
    </section>
  );
}

function PartyScreen({
  presentation = "mobile",
  scrollKey = null,
  party,
  clips,
  politicians,
  loading,
  onBack,
  following,
  onToggleFollow,
  onPlayClip,
  clipsHaveMore = false,
  clipsLoadingMore = false,
  clipsPageError = null,
  onLoadMoreClips = () => {},
  onOpenPerson
}: {
  presentation?: "mobile" | "desktop";
  scrollKey?: string | null;
  party: PartyProfile | null;
  clips: ClipItem[];
  politicians: Politician[];
  loading: boolean;
  onBack: () => void;
  following: boolean;
  onToggleFollow: () => void;
  onPlayClip: (clipId: string | null) => void;
  clipsHaveMore?: boolean;
  clipsLoadingMore?: boolean;
  clipsPageError?: string | null;
  onLoadMoreClips?: () => void;
  onOpenPerson: (personId: string) => void;
}) {
  const { scrollRef, rememberScroll } = useProfileScrollPosition(
    scrollKey,
    presentation === "desktop"
  );
  const [showEveryPolitician, setShowEveryPolitician] = useState(false);
  useEffect(() => {
    setShowEveryPolitician(false);
  }, [party?.abbr]);
  const playClip = (clipId: string | null) => {
    if (presentation === "desktop" && scrollKey && scrollRef.current) {
      desktopProfileScrollPositions.write(scrollKey, scrollRef.current.scrollTop);
    }
    onPlayClip(clipId);
  };

  if (presentation === "desktop") {
    const railPoliticians = showEveryPolitician ? politicians : politicians.slice(0, RAIL_PERSON_LIMIT);
    const facts: DesktopFact[] = [];
    if (party && typeof party.politicianCount === "number") {
      facts.push({ label: "Politiker", value: formatNumber(party.politicianCount) });
    }
    if (party && typeof party.clipCount === "number") {
      facts.push({ label: "Publicerade klipp", value: formatNumber(party.clipCount) });
    }
    if (clips.length > 0) {
      facts.push({ label: "Senaste klipp", value: formatDate(clips[0].debateDate), text: true });
    }

    return (
      <section className="party-screen party-screen--desktop">
        <DesktopProfileBar kind="Parti" name={party?.name ?? "Parti"} onBack={onBack} />
        <div ref={scrollRef} className="panel-scroll desktop-profile-scroll" onScroll={rememberScroll}>
          {loading && !party && <ProfileSkeleton variant="party" />}
          {!loading && !party && (
            <div className="panel-empty" role="status">
              <strong>Partisidan kunde inte hämtas</strong>
              <span>Försök igen om en stund.</span>
            </div>
          )}
          {party && (
            <>
              <header className="desktop-profile-hero">
                <div className="desktop-profile-hero-inner">
                  <div className="desktop-profile-mark">
                    <PartyAvatar
                      party={party.abbr}
                      color={party.color}
                      logoUrl={party.logoUrl}
                      size="xl"
                    />
                  </div>
                  <div className="desktop-profile-identity">
                    <span className="desktop-profile-eyebrow">Riksdagsparti</span>
                    <h1>{party.name}</h1>
                    {/* The party colour identifies without colouring the whole
                        masthead: one rule, not a tinted plate. */}
                    <span
                      className="desktop-party-rule"
                      style={{ background: party.color }}
                      aria-hidden="true"
                    />
                    <DesktopProfileFacts items={facts} />
                  </div>
                  <div className="desktop-profile-actions">
                    <button
                      className="desktop-action-primary"
                      type="button"
                      onClick={() => playClip(null)}
                      disabled={clips.length === 0}
                    >
                      <Play size={16} aria-hidden="true" />
                      {clipsHaveMore ? "Spela senaste klippen" : "Spela alla klipp"}
                    </button>
                    <button
                      className={following ? "desktop-action-follow is-following" : "desktop-action-follow"}
                      type="button"
                      onClick={onToggleFollow}
                    >
                      {following ? "Följer" : "Följ"}
                    </button>
                  </div>
                </div>
              </header>

              <div className="desktop-profile-body">
                <div className="desktop-profile-main">
                  <DesktopClipGallery
                    clips={clips}
                    loading={loading}
                    total={party.clipCount}
                    hasMore={clipsHaveMore}
                    loadingMore={clipsLoadingMore}
                    pageError={clipsPageError}
                    emptyTitle="Inga publicerade klipp"
                    emptyDetail="Partiets politiker har inga klipp i katalogen ännu."
                    captionFor={(clip) =>
                      [
                        cleanName(clip.politicianName ?? clip.speakerName) || clip.speakerName,
                        formatDate(clip.debateDate)
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    }
                    leadMeta={(clip) => (
                      <>
                        {clip.politicianId !== null ? (
                          <button type="button" onClick={() => onOpenPerson(clip.politicianId as string)}>
                            {cleanName(clip.politicianName ?? clip.speakerName) || clip.speakerName}
                          </button>
                        ) : (
                          <span>{clip.speakerName}</span>
                        )}
                        <i aria-hidden="true" />
                        <span>{formatDate(clip.debateDate)}</span>
                        <i aria-hidden="true" />
                        <span>{formatDuration(clip.durationS)}</span>
                        {clip.anforandetyp && <em>{clip.anforandetyp}</em>}
                      </>
                    )}
                    onPlayClip={playClip}
                    onLoadMore={onLoadMoreClips}
                  />
                </div>

                <aside className="desktop-profile-rail">
                  {politicians.length > 0 && (
                    <section className="desktop-rail-block">
                      <h2 className="desktop-rail-head">Politiker i {party.short}</h2>
                      <div
                        className={
                          showEveryPolitician
                            ? "desktop-rail-people is-scrollable"
                            : "desktop-rail-people"
                        }
                        id={`party-rail-people-${party.abbr}`}
                      >
                        {railPoliticians.map((politician) => (
                          <DesktopRailPerson
                            key={politician.id}
                            politician={politician}
                            detail={[politician.role, politician.constituency].filter(Boolean).join(" · ")}
                            onOpen={() => onOpenPerson(politician.id)}
                          />
                        ))}
                      </div>
                      {politicians.length > RAIL_PERSON_LIMIT && (
                        <button
                          className="desktop-rail-link"
                          type="button"
                          aria-expanded={showEveryPolitician}
                          aria-controls={`party-rail-people-${party.abbr}`}
                          onClick={() => setShowEveryPolitician((current) => !current)}
                        >
                          {showEveryPolitician
                            ? "Visa färre"
                            : `Alla ${formatNumber(politicians.length)} politiker`}
                          {showEveryPolitician ? (
                            <ChevronUp size={13} aria-hidden="true" />
                          ) : (
                            <ChevronDown size={13} aria-hidden="true" />
                          )}
                        </button>
                      )}
                    </section>
                  )}

                  <section className="desktop-rail-block">
                    <h2 className="desktop-rail-head">Om partiet</h2>
                    <dl className="desktop-rail-facts">
                      <DesktopRailFact label="Beteckning">
                        <span className="desktop-rail-party">
                          <i style={{ background: party.color }} aria-hidden="true" />
                          {party.abbr}
                        </span>
                      </DesktopRailFact>
                      {typeof party.politicianCount === "number" && (
                        <DesktopRailFact label="Politiker">
                          {formatNumber(party.politicianCount)}
                        </DesktopRailFact>
                      )}
                      {typeof party.clipCount === "number" && (
                        <DesktopRailFact label="Publicerade klipp">
                          {formatNumber(party.clipCount)}
                        </DesktopRailFact>
                      )}
                      <DesktopRailFact label="Källa">Sveriges riksdag</DesktopRailFact>
                    </dl>
                  </section>
                </aside>
              </div>
            </>
          )}
        </div>
      </section>
    );
  }

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
      <div ref={scrollRef} className="panel-scroll person-scroll" onScroll={rememberScroll}>
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
              <PartyAvatar
                party={party.abbr}
                color={party.color}
                logoUrl={party.logoUrl}
                size="xl"
              />
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
                      onClick={() => playClip(clip.id)}
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
  presentation = "mobile",
  scrollKey = null,
  person,
  clips,
  loading,
  onBack,
  following,
  onToggleFollow,
  onPlayClip,
  clipsHaveMore = false,
  clipsLoadingMore = false,
  clipsPageError = null,
  onLoadMoreClips = () => {},
  partyProfile = null,
  partyPeers = [],
  onOpenParty,
  onOpenPerson
}: {
  presentation?: "mobile" | "desktop";
  scrollKey?: string | null;
  person: Politician | null;
  clips: ClipItem[];
  loading: boolean;
  onBack: () => void;
  following: boolean;
  onToggleFollow: () => void;
  onPlayClip: (clipId: string | null) => void;
  clipsHaveMore?: boolean;
  clipsLoadingMore?: boolean;
  clipsPageError?: string | null;
  onLoadMoreClips?: () => void;
  partyProfile?: PartyProfile | null;
  partyPeers?: Politician[];
  onOpenParty?: (partyCode: PartyCode) => void;
  onOpenPerson?: (personId: string) => void;
}) {
  const { scrollRef, rememberScroll } = useProfileScrollPosition(
    scrollKey,
    presentation === "desktop"
  );
  const [showEveryPartyPeer, setShowEveryPartyPeer] = useState(false);
  useEffect(() => {
    setShowEveryPartyPeer(false);
  }, [person?.id]);
  const playClip = (clipId: string | null) => {
    if (presentation === "desktop" && scrollKey && scrollRef.current) {
      desktopProfileScrollPositions.write(scrollKey, scrollRef.current.scrollTop);
    }
    onPlayClip(clipId);
  };
  const displayName = person ? cleanName(person.name) || person.name : "";
  const party = person ? PARTIES[person.party] : PARTIES.NONE;
  // The exact published total, which is not the same as how many were loaded
  // onto this page. Null means it could not be read — rendered as absent, not
  // as zero.
  const total = person?.clipCount;

  if (presentation === "desktop") {
    const facts: DesktopFact[] = [];
    if (typeof total === "number") {
      facts.push({ label: "Publicerade klipp", value: formatNumber(total) });
    }
    if (clips.length > 0) {
      facts.push({ label: "Senaste klipp", value: formatDate(clips[0].debateDate), text: true });
    }
    // Party colleagues, never the person whose page this is.
    const availablePeers = person
      ? partyPeers.filter((peer) => peer.id !== person.id)
      : [];
    const peers = showEveryPartyPeer
      ? availablePeers
      : availablePeers.slice(0, RAIL_PERSON_LIMIT);
    const partyIsPublic = person !== null && person.party !== "NONE";

    return (
      <section className="person-screen person-screen--desktop">
        <DesktopProfileBar kind="Politiker" name={displayName || "Politiker"} onBack={onBack} />
        <div ref={scrollRef} className="panel-scroll desktop-profile-scroll" onScroll={rememberScroll}>
          {loading && !person && <ProfileSkeleton variant="person" />}
          {!loading && !person && (
            <div className="panel-empty" role="status">
              <strong>Profilen kunde inte hämtas</strong>
              <span>Försök igen om en stund.</span>
            </div>
          )}
          {person && (
            <>
              <header className="desktop-profile-hero">
                <div className="desktop-profile-hero-inner">
                  {/* Riksdagen's official portraits are upright. A circle crops
                      the shoulders off a press photograph; the rectangle keeps
                      the frame the photographer shot. */}
                  <div className="desktop-profile-portrait">
                    <Avatar
                      name={displayName}
                      party={person.party}
                      size="xl"
                      imageUrl={person.avatarUrl}
                    />
                    {person.avatarUrl && <span className="portrait-credit">Foto: Sveriges riksdag</span>}
                  </div>
                  <div className="desktop-profile-identity">
                    {person.role && <span className="desktop-profile-eyebrow">{person.role}</span>}
                    <h1>{displayName}</h1>
                    <div className="desktop-profile-affiliation">
                      <PartyAvatar
                        party={person.party}
                        color={party.color}
                        logoUrl={party.logoUrl}
                      />
                      {partyIsPublic && onOpenParty ? (
                        <button type="button" onClick={() => onOpenParty(person.party)}>
                          {party.name}
                        </button>
                      ) : (
                        <span className="is-plain">{party.name}</span>
                      )}
                      {person.constituency && (
                        <>
                          <i aria-hidden="true" />
                          <span className="is-plain">{person.constituency}</span>
                        </>
                      )}
                    </div>
                    <DesktopProfileFacts items={facts} />
                  </div>
                  <div className="desktop-profile-actions">
                    <button
                      className="desktop-action-primary"
                      type="button"
                      onClick={() => playClip(null)}
                      disabled={clips.length === 0}
                    >
                      <Play size={16} aria-hidden="true" />
                      {clipsHaveMore ? "Spela senaste klippen" : "Spela alla klipp"}
                    </button>
                    <button
                      className={following ? "desktop-action-follow is-following" : "desktop-action-follow"}
                      type="button"
                      onClick={onToggleFollow}
                    >
                      {following ? "Följer" : "Följ"}
                    </button>
                  </div>
                </div>
              </header>

              <div className="desktop-profile-body">
                <div className="desktop-profile-main">
                  <DesktopClipGallery
                    clips={clips}
                    loading={loading}
                    total={typeof total === "number" ? total : null}
                    hasMore={clipsHaveMore}
                    loadingMore={clipsLoadingMore}
                    pageError={clipsPageError}
                    emptyTitle="Inga publicerade klipp"
                    emptyDetail="Den här talaren har inga klipp i katalogen ännu."
                    captionFor={(clip) =>
                      [clip.sourceTitle, formatDate(clip.debateDate)].filter(Boolean).join(" · ")
                    }
                    leadMeta={(clip) => (
                      <>
                        {clip.sourceTitle && <span>{clip.sourceTitle}</span>}
                        {clip.sourceTitle && <i aria-hidden="true" />}
                        <span>{formatDate(clip.debateDate)}</span>
                        <i aria-hidden="true" />
                        <span>{formatDuration(clip.durationS)}</span>
                        {clip.anforandetyp && <em>{clip.anforandetyp}</em>}
                      </>
                    )}
                    onPlayClip={playClip}
                    onLoadMore={onLoadMoreClips}
                  />
                </div>

                <aside className="desktop-profile-rail">
                  <section className="desktop-rail-block">
                    <h2 className="desktop-rail-head">Om</h2>
                    <dl className="desktop-rail-facts">
                      <DesktopRailFact label="Parti">
                        <span className="desktop-rail-party">
                          <i style={{ background: party.color }} aria-hidden="true" />
                          {party.name}
                        </span>
                      </DesktopRailFact>
                      {person.constituency && (
                        <DesktopRailFact label="Valkrets">{person.constituency}</DesktopRailFact>
                      )}
                      {person.role && <DesktopRailFact label="Uppdrag">{person.role}</DesktopRailFact>}
                      {typeof total === "number" && (
                        <DesktopRailFact label="Publicerade klipp">
                          {formatNumber(total)}
                        </DesktopRailFact>
                      )}
                      <DesktopRailFact label="Källa">Sveriges riksdag</DesktopRailFact>
                    </dl>
                  </section>

                  {partyIsPublic && partyProfile && onOpenParty && (
                    <section className="desktop-rail-block">
                      <h2 className="desktop-rail-head">Parti</h2>
                      <div className="desktop-rail-party-card">
                        <PartyAvatar
                          party={partyProfile.abbr}
                          color={partyProfile.color}
                          logoUrl={partyProfile.logoUrl}
                        />
                        <b>{partyProfile.name}</b>
                        <span>
                          {[
                            typeof partyProfile.politicianCount === "number"
                              ? `${formatNumber(partyProfile.politicianCount)} politiker`
                              : null,
                            typeof partyProfile.clipCount === "number"
                              ? `${formatNumber(partyProfile.clipCount)} klipp`
                              : null
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </div>
                      <button
                        className="desktop-rail-link"
                        type="button"
                        onClick={() => onOpenParty(person.party)}
                      >
                        Till partisidan
                        <ChevronRight size={13} aria-hidden="true" />
                      </button>
                    </section>
                  )}

                  {peers.length > 0 && onOpenPerson && (
                    <section className="desktop-rail-block">
                      <h2 className="desktop-rail-head">Fler från {party.short}</h2>
                      <div
                        className={
                          showEveryPartyPeer
                            ? "desktop-rail-people is-scrollable"
                            : "desktop-rail-people"
                        }
                        id="person-party-peers"
                      >
                        {peers.map((peer) => (
                          <DesktopRailPerson
                            key={peer.id}
                            politician={peer}
                            detail={[peer.role, peer.constituency].filter(Boolean).join(" · ")}
                            onOpen={() => onOpenPerson(peer.id)}
                          />
                        ))}
                      </div>
                      {availablePeers.length > RAIL_PERSON_LIMIT && (
                        <button
                          className="desktop-rail-link"
                          type="button"
                          aria-expanded={showEveryPartyPeer}
                          aria-controls="person-party-peers"
                          onClick={() => setShowEveryPartyPeer((current) => !current)}
                        >
                          {showEveryPartyPeer
                            ? "Visa färre"
                            : `Alla ${formatNumber(availablePeers.length)} kollegor`}
                          {showEveryPartyPeer ? (
                            <ChevronUp size={13} aria-hidden="true" />
                          ) : (
                            <ChevronDown size={13} aria-hidden="true" />
                          )}
                        </button>
                      )}
                    </section>
                  )}
                </aside>
              </div>
            </>
          )}
        </div>
      </section>
    );
  }

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
      <div ref={scrollRef} className="panel-scroll person-scroll" onScroll={rememberScroll}>
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

            <section className="clip-grid-block">
              <div className="section-label">
                {typeof total === "number"
                  ? `Antal klipp: ${formatNumber(total)}`
                  : "Antal klipp"}
              </div>
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
                      onClick={() => playClip(clip.id)}
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
      {variant === "party" && (
        <div className="profile-skeleton-stats" aria-hidden="true">
          <span className="skeleton-shape" />
          <span className="skeleton-shape" />
        </div>
      )}
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
  logoUrl,
  size = "md"
}: {
  party: PartyCode;
  color?: string;
  logoUrl?: string | null;
  size?: "md" | "xl";
}) {
  return (
    <PartyLogo
      party={party}
      color={color}
      logoUrl={logoUrl}
      className={`party-avatar ${size}`}
    />
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
