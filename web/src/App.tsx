import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Heart,
  Home,
  MessageCircle,
  Pause,
  Play,
  Search,
  Share2,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import {
  Show,
  SignInButton,
  SignOutButton,
  SignUpButton,
  UserButton,
  useSession,
  useUser
} from "@clerk/react";
import { clerkEnabled } from "./clerk";
import { initials, PARTIES, partyInk, partyTint, PEOPLE, PERSON_CLIPS, TRENDING } from "./data";
import { checkClerkSupabaseLink, loadPublishedClips } from "./supabase";
import type { ClerkSupabaseLinkStatus } from "./supabase";
import type { ClipItem, ClipSource, FeedMode, PartyCode, PersonProfile, Tab } from "./types";

type BooleanMap = Record<string, boolean>;
type NumberMap = Record<string, number>;
type PlaybackFlash = { clipId: string; icon: "play" | "pause"; nonce: number };

const partyCodes = Object.keys(PARTIES).filter((code) => code !== "NONE") as PartyCode[];

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

function App() {
  const [tab, setTab] = useState<Tab>("hem");
  const [feedMode, setFeedMode] = useState<FeedMode>("fordig");
  // Starts empty, not seeded with demo clips (FE-1). A brief loading state is
  // honest; a flash of fabricated content that then becomes real is not.
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [clipSource, setClipSource] = useState<ClipSource>("supabase");
  const [feedError, setFeedError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [partyFilter, setPartyFilter] = useState<PartyCode | null>(null);
  const [liked, setLiked] = useState<BooleanMap>({});
  const [saved, setSaved] = useState<BooleanMap>({});
  const [muted, setMuted] = useState(false);
  const [following, setFollowing] = useState<BooleanMap>({});
  const [followedParties, setFollowedParties] = useState<Record<PartyCode, boolean>>({
    S: false,
    M: false,
    V: false,
    SD: false,
    C: false,
    KD: false,
    MP: false,
    L: false,
    NONE: false
  });
  // Consent defaults to off. These switches are still in-memory only and do not
  // yet gate any server-side processing — see docs/RECOMMENDATION_PREREQUISITES.md C-5.
  const [consent, setConsent] = useState({ personal: false, analytics: false, email: false });

  useEffect(() => {
    let mounted = true;
    loadPublishedClips()
      .then((feed) => {
        if (mounted) {
          setClips(feed.clips);
          setClipSource(feed.source);
          setFeedError(feed.error ?? null);
        }
      })
      .catch((error: unknown) => {
        if (mounted) {
          setClips([]);
          setFeedError(error instanceof Error ? error.message : "Okänt fel");
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  const selectedPerson = useMemo(
    () => PEOPLE.find((person) => person.id === selectedPersonId) ?? null,
    [selectedPersonId]
  );

  const people = useMemo(() => mergePeopleFromClips(clips), [clips]);

  const openPerson = (personId: string) => {
    setSelectedPersonId(personId);
  };

  const closePerson = () => {
    setSelectedPersonId(null);
  };

  const visiblePerson = selectedPerson ?? people.find((person) => person.id === selectedPersonId) ?? null;

  return (
    <>
      <WideScreenMessage />
      <main className="mobile-app" aria-label="Riket TV">
        {visiblePerson ? (
          <PersonScreen
            person={visiblePerson}
            onBack={closePerson}
            following={!!following[visiblePerson.id]}
            onToggleFollow={() => setFollowing((state) => ({ ...state, [visiblePerson.id]: !state[visiblePerson.id] }))}
          />
        ) : (
          <>
            {tab === "hem" && (
              <FeedScreen
                clips={clips}
                feedMode={feedMode}
                setFeedMode={setFeedMode}
                muted={muted}
                setMuted={setMuted}
                liked={liked}
                saved={saved}
                following={following}
                loading={loading}
                clipSource={clipSource}
                feedError={feedError}
                onLike={(clipId) => setLiked((state) => ({ ...state, [clipId]: !state[clipId] }))}
                onSave={(clipId) => setSaved((state) => ({ ...state, [clipId]: !state[clipId] }))}
                onToggleFollow={(personId) =>
                  setFollowing((state) => ({ ...state, [personId]: !state[personId] }))
                }
                onOpenPerson={openPerson}
              />
            )}
            {tab === "foljer" && (
              <FollowingScreen
                people={people}
                following={following}
                followedParties={followedParties}
                onOpenPerson={openPerson}
                onTogglePerson={(personId) =>
                  setFollowing((state) => ({ ...state, [personId]: !state[personId] }))
                }
                onToggleParty={(party) =>
                  setFollowedParties((state) => ({ ...state, [party]: !state[party] }))
                }
              />
            )}
            {tab === "sok" && (
              <SearchScreen
                people={people}
                query={query}
                setQuery={setQuery}
                partyFilter={partyFilter}
                setPartyFilter={setPartyFilter}
                onOpenPerson={openPerson}
              />
            )}
            {tab === "profil" && (
              <ProfileScreen
                consent={consent}
                onToggleConsent={(key) => setConsent((state) => ({ ...state, [key]: !state[key] }))}
              />
            )}
            <BottomNav active={tab} onChange={setTab} />
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
        <div className="wide-kicker">Riket TV</div>
        <h1>Öppna appen på en mobilskärm.</h1>
        <p>Den första versionen är byggd för en fullskärms 9:16-feed. Surfa från mobilen för hela upplevelsen.</p>
      </div>
    </section>
  );
}

function FeedScreen({
  clips,
  feedMode,
  setFeedMode,
  muted,
  setMuted,
  liked,
  saved,
  following,
  loading,
  clipSource,
  feedError,
  onLike,
  onSave,
  onToggleFollow,
  onOpenPerson
}: {
  clips: ClipItem[];
  feedMode: FeedMode;
  setFeedMode: (mode: FeedMode) => void;
  muted: boolean;
  setMuted: (muted: boolean) => void;
  liked: BooleanMap;
  saved: BooleanMap;
  following: BooleanMap;
  loading: boolean;
  clipSource: ClipSource;
  feedError: string | null;
  onLike: (clipId: string) => void;
  onSave: (clipId: string) => void;
  onToggleFollow: (personId: string) => void;
  onOpenPerson: (personId: string) => void;
}) {
  const [activeId, setActiveId] = useState(clips[0]?.id ?? "");
  const [paused, setPaused] = useState<BooleanMap>({});
  /**
   * FE-5. Autoplay blocked by browser policy is not a user pause. Conflating
   * them would record "browser refused to start unmuted audio" as a negative
   * preference signal, which is the opposite of what happened. Kept separate
   * from `paused` so the two can never be read as the same thing.
   */
  const [blocked, setBlocked] = useState<BooleanMap>({});
  const [currentTimes, setCurrentTimes] = useState<NumberMap>({});
  const [durations, setDurations] = useState<NumberMap>({});
  const [playbackFlash, setPlaybackFlash] = useState<PlaybackFlash | null>(null);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const flashTimer = useRef<number | null>(null);
  /**
   * FE-3. Loop boundaries per clip. A completion is the first `ended`; every
   * later one is a deliberate replay of a clip the viewer chose not to scroll
   * past. F2 reads this when the event stream exists; keeping the count now
   * means the distinction is observable from the day telemetry is switched on.
   */
  const loopCounts = useRef<Record<string, number>>({});

  useEffect(() => {
    setActiveId(clips[0]?.id ?? "");
    setPaused({});
    setBlocked({});
    setCurrentTimes({});
    setDurations({});
    setPlaybackFlash(null);
    loopCounts.current = {};
  }, [clips]);

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
    void video.play().catch(() => setBlocked((state) => ({ ...state, [clipId]: true })));
  };

  useEffect(() => {
    return () => {
      if (flashTimer.current !== null) {
        window.clearTimeout(flashTimer.current);
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
    Object.entries(videoRefs.current).forEach(([clipId, video]) => {
      if (!video) {
        return;
      }
      video.muted = muted;
      if (clipId === activeId) {
        video
          .play()
          .then(() => {
            setPaused((state) => ({ ...state, [clipId]: false }));
            setBlocked((state) => ({ ...state, [clipId]: false }));
          })
          .catch(() => {
            // FE-5: browser policy refused unmuted autoplay. Record it as
            // blocked, never as a pause the viewer chose.
            setPaused((state) => ({ ...state, [clipId]: true }));
            setBlocked((state) => ({ ...state, [clipId]: true }));
          });
      } else {
        video.pause();
      }
    });
  }, [activeId, clips]);

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

  const toggleClipPlayback = (clipId: string) => {
    const video = videoRefs.current[clipId];
    if (!video || clipId !== activeId) {
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
      return;
    }
    const fallbackDuration = durations[clipId] ?? clips.find((clip) => clip.id === clipId)?.durationS ?? 0;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : fallbackDuration;
    const nextTime = Math.min(Math.max(seconds, 0), duration);
    video.currentTime = nextTime;
    setCurrentTimes((state) => ({ ...state, [clipId]: nextTime }));
  };

  return (
    <section className="feed-screen">
      <div className="feed-tabs" role="tablist" aria-label="Flöde">
        <button className={feedMode === "fordig" ? "active" : ""} onClick={() => setFeedMode("fordig")}>
          För dig
        </button>
        <button className={feedMode === "senaste" ? "active" : ""} onClick={() => setFeedMode("senaste")}>
          Senaste
        </button>
      </div>

      {loading && <div className="loading-chip">Hämtar klipp</div>}

      {clipSource === "sample" && <div className="loading-chip">Demodata</div>}

      {/* FE-12: an honest empty state. Demo clips must never quietly stand in
          for a failed or empty catalogue read. */}
      {!loading && clips.length === 0 && (
        <div className="feed-empty" role="status">
          <strong>Inga klipp att visa</strong>
          <span>{feedError ? "Klippen kunde inte hämtas just nu." : "Kom tillbaka snart."}</span>
        </div>
      )}

      <div className="feed-scroll">
        {clips.map((clip) => {
          const person = personForClip(clip);
          const isLiked = !!liked[clip.id];
          const isSaved = !!saved[clip.id];
          const isFollowing = !!following[person.id];
          const flashIcon = playbackFlash?.clipId === clip.id ? playbackFlash.icon : null;
          const flashNonce = playbackFlash?.clipId === clip.id ? playbackFlash.nonce : null;
          return (
            <article
              className="feed-item"
              data-clip-id={clip.id}
              key={clip.id}
              onClick={() => toggleClipPlayback(clip.id)}
            >
              <video
                ref={(node) => {
                  videoRefs.current[clip.id] = node;
                }}
                src={clip.videoUrl}
                poster={clip.thumbUrl}
                autoPlay={clip.id === activeId}
                playsInline
                muted={muted}
                /* FE-3 (GATE): no `loop` attribute. Native looping made
                   completion and deliberate replay indistinguishable, which
                   costs two of the strongest positive signals. The clip still
                   loops — see onEnded — but the boundary is now an event we
                   can count. */
                preload="metadata"
                onLoadedMetadata={(event) => {
                  const duration = event.currentTarget.duration;
                  setDurations((state) => ({
                    ...state,
                    [clip.id]: Number.isFinite(duration) && duration > 0 ? duration : clip.durationS
                  }));
                }}
                onTimeUpdate={(event) => {
                  const currentTime = event.currentTarget.currentTime;
                  setCurrentTimes((state) => ({ ...state, [clip.id]: currentTime }));
                }}
                onEnded={(event) => handleClipEnded(clip.id, event.currentTarget)}
                onPlay={() => {
                  setPaused((state) => ({ ...state, [clip.id]: false }));
                  setBlocked((state) => ({ ...state, [clip.id]: false }));
                }}
                onPause={() => setPaused((state) => ({ ...state, [clip.id]: true }))}
              />
              {flashIcon && flashNonce !== null && <PlaybackFlashIcon key={flashNonce} icon={flashIcon} />}
              {/* FE-5: only shown when browser policy refused autoplay, never
                  for a pause the viewer chose. AGENTS.md documents this
                  affordance; without it a blocked clip is a frozen poster with
                  no visible way to start it. */}
              {blocked[clip.id] && clip.id === activeId && (
                <button
                  className="center-play"
                  aria-label="Spela upp"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleClipPlayback(clip.id);
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
                  setMuted(!muted);
                }}
              >
                {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
              <ActionRail
                clip={clip}
                liked={isLiked}
                saved={isSaved}
                onLike={() => onLike(clip.id)}
                onSave={() => onSave(clip.id)}
              />
              <ClipMeta
                clip={clip}
                person={person}
                following={isFollowing}
                onOpenPerson={() => onOpenPerson(person.id)}
                onToggleFollow={() => onToggleFollow(person.id)}
              />
              <ProgressRow
                currentTime={currentTimes[clip.id] ?? 0}
                duration={durations[clip.id] ?? clip.durationS}
                onSeek={(seconds) => seekClip(clip.id, seconds)}
              />
            </article>
          );
        })}
      </div>
    </section>
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
  onSave
}: {
  clip: ClipItem;
  liked: boolean;
  saved: boolean;
  onLike: () => void;
  onSave: () => void;
}) {
  return (
    <div className="action-rail" onClick={(event) => event.stopPropagation()}>
      {/* FE-2: no counts until a real one exists. These used to render
          `1200 + index * 143` as if it were a measured figure. */}
      <ActionButton label="Gilla" active={liked} onClick={onLike}>
        <Heart size={21} fill={liked ? "currentColor" : "none"} />
      </ActionButton>
      {/* Icon only: no Swedish word for this fits the 54px rail, and there is
          no real count to put there. The accessible name still describes it. */}
      <ActionButton label="Kommentarer" hideLabel>
        <MessageCircle size={21} />
      </ActionButton>
      <ActionButton label="Spara" active={saved} onClick={onSave}>
        <Bookmark size={21} fill={saved ? "currentColor" : "none"} />
      </ActionButton>
      <ActionButton label="Dela">
        <Share2 size={21} />
      </ActionButton>
    </div>
  );
}

function ActionButton({
  children,
  label,
  active = false,
  hideLabel = false,
  onClick
}: {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  /** Keep the accessible name, drop the visible caption. */
  hideLabel?: boolean;
  onClick?: () => void;
}) {
  return (
    <div className="action">
      <button className={active ? "active" : ""} onClick={onClick} aria-label={label}>
        {children}
      </button>
      {!hideLabel && <span>{label}</span>}
    </div>
  );
}

function ClipMeta({
  clip,
  person,
  following,
  onOpenPerson,
  onToggleFollow
}: {
  clip: ClipItem;
  person: PersonProfile;
  following: boolean;
  onOpenPerson: () => void;
  onToggleFollow: () => void;
}) {
  const party = PARTIES[clip.party];
  const displayName = cleanName(clip.speakerName) || person.name;
  const speechType = clip.anforandetyp || person.role;
  return (
    <div className="clip-meta" onClick={(event) => event.stopPropagation()}>
      <div className="person-row">
        <button className="person-pill" onClick={onOpenPerson}>
          <Avatar name={displayName} party={clip.party} size="sm" />
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
          aria-pressed={following}
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

function FollowingScreen({
  people,
  following,
  followedParties,
  onOpenPerson,
  onTogglePerson,
  onToggleParty
}: {
  people: PersonProfile[];
  following: BooleanMap;
  followedParties: Record<PartyCode, boolean>;
  onOpenPerson: (personId: string) => void;
  onTogglePerson: (personId: string) => void;
  onToggleParty: (party: PartyCode) => void;
}) {
  const activeParties = partyCodes.filter((party) => followedParties[party]);
  const activePeople = people.filter((person) => following[person.id]);
  return (
    <section className="panel-screen">
      <Header title="Följer" subtitle={`${activeParties.length} partier · ${activePeople.length} personer`} />
      <div className="panel-scroll">
        <Group title="Partier">
          {activeParties.map((partyCode) => {
            const party = PARTIES[partyCode];
            return (
              <ListRow
                key={partyCode}
                avatar={<PartyAvatar party={partyCode} />}
                title={party.name}
                subtitle={`${formatNumber(party.clips)} klipp`}
                action={
                  <button className="mini-button" onClick={() => onToggleParty(partyCode)}>
                    Följer
                  </button>
                }
              />
            );
          })}
        </Group>
        <Group title="Personer">
          {activePeople.map((person) => (
            <ListRow
              key={person.id}
              avatar={<Avatar name={person.name} party={person.party} size="md" />}
              title={person.name}
              subtitle={`${PARTIES[person.party].name} · ${person.role}`}
              onClick={() => onOpenPerson(person.id)}
              action={
                <button
                  className="mini-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onTogglePerson(person.id);
                  }}
                >
                  Följer
                </button>
              }
            />
          ))}
        </Group>
      </div>
    </section>
  );
}

function SearchScreen({
  people,
  query,
  setQuery,
  partyFilter,
  setPartyFilter,
  onOpenPerson
}: {
  people: PersonProfile[];
  query: string;
  setQuery: (query: string) => void;
  partyFilter: PartyCode | null;
  setPartyFilter: (party: PartyCode | null) => void;
  onOpenPerson: (personId: string) => void;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const results = people.filter((person) => {
    const party = PARTIES[person.party];
    const matchesFilter = !partyFilter || person.party === partyFilter;
    const matchesQuery =
      !normalizedQuery ||
      person.name.toLowerCase().includes(normalizedQuery) ||
      party.name.toLowerCase().includes(normalizedQuery) ||
      person.role.toLowerCase().includes(normalizedQuery);
    return matchesFilter && matchesQuery;
  });
  const showResults = normalizedQuery.length > 0 || partyFilter !== null;

  return (
    <section className="panel-screen">
      <div className="search-header">
        <label className="search-box">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Sök person, parti eller ämne" />
          {query.length > 0 && (
            <button onClick={() => setQuery("")} aria-label="Rensa">
              <X size={13} />
            </button>
          )}
        </label>
        <div className="chips">
          <button className={partyFilter === null ? "active" : ""} onClick={() => setPartyFilter(null)}>
            <i />
            Alla
          </button>
          {partyCodes.map((party) => (
            <button key={party} className={partyFilter === party ? "active" : ""} onClick={() => setPartyFilter(party)}>
              <i style={{ background: PARTIES[party].color }} />
              {party}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-scroll">
        {showResults ? (
          <Group title={`${results.length} ${results.length === 1 ? "träff" : "träffar"}`}>
            {results.map((person) => (
              <ListRow
                key={person.id}
                avatar={<Avatar name={person.name} party={person.party} size="md" />}
                title={person.name}
                subtitle={`${PARTIES[person.party].name} · ${formatNumber(person.clips)} klipp`}
                onClick={() => onOpenPerson(person.id)}
                chevron
              />
            ))}
          </Group>
        ) : (
          <>
            <section className="recent-block">
              <div className="section-label">
                Senaste sökningar
                <button onClick={() => setQuery("")}>Rensa</button>
              </div>
              <div className="recent-chips">
                {["Gunnar Strömmer", "Socialdemokraterna", "polisnärvaro", "budgetdebatt"].map((item) => (
                  <button key={item} onClick={() => setQuery(item)}>
                    <Clock3 size={12} />
                    {item}
                  </button>
                ))}
              </div>
            </section>
            <Group title="Populära debatter">
              {TRENDING.map((item) => (
                <ListRow key={item.n} eyebrow={item.n} title={item.title} subtitle={item.meta} action={<span className="up">{item.up}</span>} />
              ))}
            </Group>
          </>
        )}
      </div>
    </section>
  );
}

function ProfileScreen({
  consent,
  onToggleConsent
}: {
  consent: { personal: boolean; analytics: boolean; email: boolean };
  onToggleConsent: (key: keyof typeof consent) => void;
}) {
  const consentRows = [
    { key: "personal" as const, title: "Personaliserat flöde", help: "Använder tittarbeteende för att välja klipp." },
    { key: "analytics" as const, title: "Analys & statistik", help: "Anonym statistik som förbättrar appen." },
    { key: "email" as const, title: "Aviseringar via e-post", help: "Nya klipp från personer och partier du följer." }
  ];
  return (
    <section className="panel-screen">
      <Header title="Profil" />
      <div className="panel-scroll">
        <AccountCard />
        {/* FE-2: "Sparade klipp 24" and "Följda ämnen 12" were invented. Saves
            and follows do not persist anywhere yet (C-9), so there is no honest
            number to show and the rows are gone until F1 stores them. */}
        <Group title="Konto">
          <ListRow title="Sparade klipp" chevron />
          <ListRow title="Aviseringar" chevron />
          <ListRow title="Följda ämnen" chevron />
        </Group>
        <Group title="Integritet & data">
          {consentRows.map((row) => (
            <ListRow
              key={row.key}
              title={row.title}
              subtitle={row.help}
              action={<Switch checked={consent[row.key]} onChange={() => onToggleConsent(row.key)} />}
            />
          ))}
          <ListRow title="Ladda ner mina data" icon={<Download size={18} />} chevron />
          <ListRow title="Samtycken & cookies" icon={<ShieldCheck size={18} />} chevron />
          <ListRow title="Radera konto" icon={<Trash2 size={18} />} tone="danger" chevron />
        </Group>
        {clerkEnabled && (
          <Show when="signed-in">
            <AuthDiagnostics />
          </Show>
        )}
        <div className="version">Kammaren 1.0 · data från riksdagen.se</div>
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
function AccountCard() {
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
 * Signed-in-only check that the Clerk → Supabase link actually works.
 *
 * Prerequisite A-3 / A-4. Configuring the integration in two dashboards proves
 * nothing on its own; this calls `public.auth_probe()`, which is granted to
 * `authenticated` and revoked from `anon`, and shows what Postgres saw. A `sub`
 * that matches the Clerk user id is the end-to-end evidence.
 *
 * It reads only the signed-in caller's own claims and stays in the app on
 * purpose — a check that lives in someone's shell history is a check nobody
 * else can repeat.
 */
function AuthDiagnostics() {
  const { session } = useSession();
  const [status, setStatus] = useState<ClerkSupabaseLinkStatus | null>(null);
  const [running, setRunning] = useState(false);

  const run = () => {
    setRunning(true);
    checkClerkSupabaseLink(async () => (await session?.getToken()) ?? null)
      .then(setStatus)
      .catch((error: unknown) =>
        setStatus({
          state: "rejected",
          status: 0,
          detail: error instanceof Error ? error.message : String(error),
          token: {
            sub: null,
            role: null,
            iss: null,
            azp: null,
            expiresInS: null,
            claimKeys: [],
            url: "(request never left the browser)"
          }
        })
      )
      .finally(() => setRunning(false));
  };

  return (
    <Group title="Diagnostik">
      <ListRow
        title="Testa Clerk → Supabase"
        subtitle={describeLinkStatus(status, running)}
        action={
          <button className="mini-button" onClick={run} disabled={running}>
            Kör
          </button>
        }
      />
      {status?.state === "ok" && (
        <pre className="diagnostic-output">{JSON.stringify(status.claims, null, 2)}</pre>
      )}
      {/* Always show the raw response and the token summary on failure. Which
          of `iss`, `role` or the URL is wrong produces very different fixes,
          and a one-line Swedish label cannot carry that. */}
      {(status?.state === "rejected" || status?.state === "probe-missing") && (
        <pre className="diagnostic-output">
          {JSON.stringify({ token: status.token, response: status.detail }, null, 2)}
        </pre>
      )}
    </Group>
  );
}

function describeLinkStatus(status: ClerkSupabaseLinkStatus | null, running: boolean): string {
  if (running) {
    return "Kör…";
  }
  switch (status?.state) {
    case undefined:
      return "Kontrollerar att Supabase accepterar Clerk-token.";
    case "ok":
      return `OK — Postgres ser sub=${status.claims.sub ?? "?"} som roll ${status.claims.pg_role}.`;
    case "probe-missing":
      return "404 från Supabase — se svaret nedan.";
    case "signed-out":
      return "Ingen aktiv session.";
    case "unconfigured":
      return "Supabase är inte konfigurerat.";
    case "rejected":
      return `Avvisad med HTTP ${status.status}.`;
  }
}

function PersonScreen({
  person,
  onBack,
  following,
  onToggleFollow
}: {
  person: PersonProfile;
  onBack: () => void;
  following: boolean;
  onToggleFollow: () => void;
}) {
  return (
    <section className="person-screen">
      <div className="person-topbar">
        <button onClick={onBack} aria-label="Tillbaka">
          <ChevronLeft size={24} />
        </button>
        <strong>{person.name}</strong>
        <button aria-label="Dela">
          <Share2 size={19} />
        </button>
      </div>
      <div className="panel-scroll person-scroll">
        <section className="person-hero">
          <Avatar name={person.name} party={person.party} size="xl" />
          <h1>{person.name}</h1>
          <span className="party-pill">
            <i style={{ background: PARTIES[person.party].color }} />
            {PARTIES[person.party].name}
          </span>
          <p>{person.role} · {person.constituency}</p>
          <button className={following ? "follow-wide following" : "follow-wide"} onClick={onToggleFollow}>
            {following ? "Följer" : "Följ"}
          </button>
        </section>
        <div className="stats">
          <Stat label="Klipp" value={formatNumber(person.clips)} />
          <Stat label="Följare" value={formatNumber(person.followers)} />
          <Stat label="Anföranden" value={formatNumber(person.speeches)} />
        </div>
        <Group title="Om">
          <div className="bio">{person.bio}</div>
        </Group>
        <section className="tag-block">
          <div className="section-label">Utskott</div>
          <div className="recent-chips">
            {person.committees.map((committee) => (
              <button key={committee}>{committee}</button>
            ))}
          </div>
        </section>
        <section className="clip-grid-block">
          <div className="section-label">Klipp</div>
          <div className="clip-grid">
            {PERSON_CLIPS.map((clip, index) => (
              <div className="mini-clip" key={`${clip.date}-${index}`}>
                <span>{clip.date}</span>
                <div>
                  <b>{clip.views}</b>
                  <b>{clip.dur}</b>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </section>
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
  return (
    <div className={tone === "danger" ? "list-row danger" : "list-row"} onClick={onClick}>
      {avatar}
      {icon && <span className="row-icon">{icon}</span>}
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <div className="row-copy">
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      {action}
      {chevron && <ChevronRight className="chevron" size={17} />}
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

function Avatar({ name, party, size }: { name: string; party: PartyCode; size: "sm" | "md" | "lg" | "xl" }) {
  const partyProfile = PARTIES[party] ?? PARTIES.NONE;
  return (
    <span
      className={`avatar ${size}`}
      style={{
        background: partyTint(partyProfile.color),
        color: partyInk(partyProfile.color)
      }}
    >
      {initials(name)}
    </span>
  );
}

function PartyAvatar({ party }: { party: PartyCode }) {
  const profile = PARTIES[party];
  return (
    <span className="party-avatar" style={{ background: partyTint(profile.color), color: partyInk(profile.color) }}>
      {profile.abbr}
    </span>
  );
}

function mergePeopleFromClips(clips: ClipItem[]): PersonProfile[] {
  const byId = new Map(PEOPLE.map((person) => [person.id, person]));
  clips.forEach((clip) => {
    const person = personForClip(clip);
    if (!byId.has(person.id)) {
      byId.set(person.id, person);
    }
  });
  return Array.from(byId.values());
}

function personForClip(clip: ClipItem): PersonProfile {
  const cleanSpeaker = cleanName(clip.speakerName);
  const existing = PEOPLE.find((person) => {
    const cleanPerson = cleanName(person.name);
    return cleanSpeaker.includes(cleanPerson) || cleanPerson.includes(cleanSpeaker);
  });
  if (existing) {
    return existing;
  }
  return {
    id: slugify(cleanSpeaker || clip.speakerName),
    name: cleanSpeaker || clip.speakerName,
    party: clip.party,
    role: clip.anforandetyp || "Riksdagsledamot",
    constituency: "Riksdagen",
    clips: 1,
    followers: 0,
    speeches: 1,
    bio: clip.transcript || clip.title,
    committees: [clip.topic ?? clip.sourceTitle]
  };
}

function cleanName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, "")
    .replace(/^(Justitieministern|Statsministern|Ministern|Ledamoten)\s+/i, "")
    .trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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
