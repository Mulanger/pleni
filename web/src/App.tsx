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
import { initials, PARTIES, partyInk, partyTint, PEOPLE, PERSON_CLIPS, SAMPLE_CLIPS, TRENDING } from "./data";
import { loadPublishedClips } from "./supabase";
import type { ClipItem, FeedMode, PartyCode, PersonProfile, Tab } from "./types";

type BooleanMap = Record<string, boolean>;
type NumberMap = Record<string, number>;
type PlaybackFlash = { clipId: string; icon: "play" | "pause"; nonce: number };

const partyCodes = Object.keys(PARTIES).filter((code) => code !== "NONE") as PartyCode[];

function App() {
  const [tab, setTab] = useState<Tab>("hem");
  const [feedMode, setFeedMode] = useState<FeedMode>("fordig");
  const [clips, setClips] = useState<ClipItem[]>(SAMPLE_CLIPS);
  const [loading, setLoading] = useState(true);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [partyFilter, setPartyFilter] = useState<PartyCode | null>(null);
  const [liked, setLiked] = useState<BooleanMap>({ [SAMPLE_CLIPS[1]?.id ?? ""]: true });
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
  const [consent, setConsent] = useState({ personal: true, analytics: false, email: true });

  useEffect(() => {
    let mounted = true;
    loadPublishedClips()
      .then((published) => {
        if (mounted) {
          setClips(published);
        }
      })
      .catch(() => {
        if (mounted) {
          setClips(SAMPLE_CLIPS);
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
  onLike: (clipId: string) => void;
  onSave: (clipId: string) => void;
  onToggleFollow: (personId: string) => void;
  onOpenPerson: (personId: string) => void;
}) {
  const [activeId, setActiveId] = useState(clips[0]?.id ?? "");
  const [paused, setPaused] = useState<BooleanMap>({});
  const [currentTimes, setCurrentTimes] = useState<NumberMap>({});
  const [durations, setDurations] = useState<NumberMap>({});
  const [playbackFlash, setPlaybackFlash] = useState<PlaybackFlash | null>(null);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const flashTimer = useRef<number | null>(null);

  useEffect(() => {
    setActiveId(clips[0]?.id ?? "");
    setPaused({});
    setCurrentTimes({});
    setDurations({});
    setPlaybackFlash(null);
  }, [clips]);

  useEffect(() => {
    return () => {
      if (flashTimer.current !== null) {
        window.clearTimeout(flashTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveId((entry.target as HTMLElement).dataset.clipId ?? "");
          }
        });
      },
      { threshold: 0.72 }
    );
    document.querySelectorAll<HTMLElement>("[data-clip-id]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
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
          .then(() => setPaused((state) => ({ ...state, [clipId]: false })))
          .catch(() => setPaused((state) => ({ ...state, [clipId]: true })));
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
                loop
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
                onPlay={() => setPaused((state) => ({ ...state, [clip.id]: false }))}
                onPause={() => setPaused((state) => ({ ...state, [clip.id]: true }))}
              />
              {flashIcon && flashNonce !== null && <PlaybackFlashIcon key={flashNonce} icon={flashIcon} />}
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
      <ActionButton label={formatNumber(clip.likes + (liked ? 1 : 0))} active={liked} onClick={onLike}>
        <Heart size={21} fill={liked ? "currentColor" : "none"} />
      </ActionButton>
      <ActionButton label={formatNumber(clip.comments)}>
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
  onClick
}: {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <div className="action">
      <button className={active ? "active" : ""} onClick={onClick} aria-label={label}>
        {children}
      </button>
      <span>{label}</span>
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
        <div className="profile-card">
          <Avatar name="Elin Norberg" party="NONE" size="lg" />
          <div>
            <strong>Elin Norberg</strong>
            <span>elin.norberg@mail.se</span>
          </div>
          <button className="mini-button">Redigera</button>
        </div>
        <Group title="Konto">
          <ListRow title="Sparade klipp" action={<span className="muted">24</span>} chevron />
          <ListRow title="Aviseringar" action={<span className="muted">På</span>} chevron />
          <ListRow title="Följda ämnen" action={<span className="muted">12</span>} chevron />
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
        <button className="logout-button">Logga ut</button>
        <div className="version">Kammaren 1.0 · data från riksdagen.se</div>
      </div>
    </section>
  );
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
