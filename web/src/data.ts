import type { ClipItem, PartyCode, PartyProfile, PersonProfile } from "./types";

export const PARTIES: Record<PartyCode, PartyProfile> = {
  S: { abbr: "S", name: "Socialdemokraterna", short: "Socialdemokraterna", color: "#E8112D", clips: 1240 },
  M: { abbr: "M", name: "Moderaterna", short: "Moderaterna", color: "#3E9FD1", clips: 1108 },
  SD: { abbr: "SD", name: "Sverigedemokraterna", short: "Sverigedemokr.", color: "#B99A00", clips: 964 },
  C: { abbr: "C", name: "Centerpartiet", short: "Centerpartiet", color: "#009933", clips: 612 },
  V: { abbr: "V", name: "Vänsterpartiet", short: "Vänsterpartiet", color: "#AF0000", clips: 701 },
  KD: { abbr: "KD", name: "Kristdemokraterna", short: "Kristdemokr.", color: "#005CA9", clips: 534 },
  MP: { abbr: "MP", name: "Miljöpartiet", short: "Miljöpartiet", color: "#4F9B2E", clips: 498 },
  L: { abbr: "L", name: "Liberalerna", short: "Liberalerna", color: "#006AB3", clips: 410 },
  NONE: { abbr: "NONE", name: "Partilös", short: "Partilös", color: "#8f8f87", clips: 0 }
};

export const PEOPLE: PersonProfile[] = [
  {
    id: "gunnar-strommer",
    name: "Gunnar Strömmer",
    party: "M",
    role: "Justitieminister",
    constituency: "Stockholms kommun",
    clips: 112,
    followers: 16800,
    speeches: 276,
    bio: "Justitieminister sedan 2022. Ansvarar för rättsväsende och kriminalpolitik.",
    committees: ["Justitieutskottet"]
  },
  {
    id: "mathias-tegner",
    name: "Mathias Tegnér",
    party: "S",
    role: "Riksdagsledamot",
    constituency: "Stockholms län",
    clips: 76,
    followers: 8900,
    speeches: 342,
    bio: "Riksdagsledamot och återkommande debattör i frågor om lokal polisnärvaro.",
    committees: ["Justitieutskottet"]
  },
  {
    id: "ulf-kristersson",
    name: "Ulf Kristersson",
    party: "M",
    role: "Statsminister",
    constituency: "Södermanlands län",
    clips: 214,
    followers: 48200,
    speeches: 611,
    bio: "Partiledare för Moderaterna sedan 2017 och statsminister sedan 2022.",
    committees: ["Utrikesnämnden"]
  },
  {
    id: "magdalena-andersson",
    name: "Magdalena Andersson",
    party: "S",
    role: "Partiledare",
    constituency: "Stockholms kommun",
    clips: 198,
    followers: 51400,
    speeches: 574,
    bio: "Partiledare för Socialdemokraterna sedan 2021. Tidigare finansminister och statsminister.",
    committees: ["Finansutskottet"]
  },
  {
    id: "nooshi-dadgostar",
    name: "Nooshi Dadgostar",
    party: "V",
    role: "Partiledare",
    constituency: "Stockholms län",
    clips: 163,
    followers: 39100,
    speeches: 488,
    bio: "Partiledare för Vänsterpartiet sedan 2020. Talar ofta om bostadspolitik och välfärd.",
    committees: ["Finansutskottet", "Civilutskottet"]
  },
  {
    id: "elisabeth-svantesson",
    name: "Elisabeth Svantesson",
    party: "M",
    role: "Finansminister",
    constituency: "Örebro län",
    clips: 142,
    followers: 27500,
    speeches: 418,
    bio: "Finansminister sedan 2022 och vice partiledare för Moderaterna.",
    committees: ["Finansutskottet"]
  }
];

export const TRENDING = [
  { n: "1", title: "Lokal polisnärvaro", meta: "16 klipp · 2 talare", up: "+18%" },
  { n: "2", title: "Vårändringsbudgeten 2026", meta: "128 klipp · 42 talare", up: "+12%" },
  { n: "3", title: "Försvarsanslagen", meta: "96 klipp · 31 talare", up: "+9%" },
  { n: "4", title: "Elpriser och kärnkraft", meta: "84 klipp · 27 talare", up: "+7%" },
  { n: "5", title: "Vårdköerna", meta: "71 klipp · 24 talare", up: "+4%" }
];

export const PERSON_CLIPS = [
  { date: "3 jun", views: "48 t", dur: "0:44" },
  { date: "3 jun", views: "31 t", dur: "0:55" },
  { date: "3 jun", views: "27 t", dur: "0:40" },
  { date: "17 apr", views: "19 t", dur: "1:12" },
  { date: "28 mar", views: "16 t", dur: "0:51" },
  { date: "21 mar", views: "12 t", dur: "0:47" }
];

const sourceUrl =
  "https://www.riksdagen.se/sv/webb-tv/video/interpellationsdebatt/lokal-polisnarvaro-och-fler-polisstationer_hd10540/";

export const SAMPLE_CLIPS: ClipItem[] = [
  {
    id: "HD10540_e0bb9ba6-5d6e-f111-bf27-6805cafeabf9_c02",
    speechId: "HD10540_e0bb9ba6-5d6e-f111-bf27-6805cafeabf9",
    speakerName: "Gunnar Strömmer",
    party: "M",
    anforandetyp: "Svar",
    archetype: "CONFRONT",
    title: "Mathias Tegnér har även frågat mig om jag anser att en",
    transcript: "Mathias Tegnér har även frågat mig om jag anser att en lokal polisstation gör skillnad.",
    topic: "polisnärvaro",
    durationS: 44.341,
    videoUrl:
      "https://riketnlooigm.b-cdn.net/clips/2026/06/HD10540_e0bb9ba6-5d6e-f111-bf27-6805cafeabf9_c02_540x960.mp4",
    thumbUrl:
      "https://riketnlooigm.b-cdn.net/thumbs/2026/06/HD10540_e0bb9ba6-5d6e-f111-bf27-6805cafeabf9_c02.webp",
    sourceTitle: "Lokal polisnärvaro och fler polisstationer",
    sourceUrl,
    debateDate: "2026-06-03",
    publishedAt: "2026-08-02T00:00:00Z",
    rank: 1,
    isSample: true
  },
  {
    id: "HD10540_e0bb9ba6-5d6e-f111-bf27-6805cafeabf9_c01",
    speechId: "HD10540_e0bb9ba6-5d6e-f111-bf27-6805cafeabf9",
    speakerName: "Gunnar Strömmer",
    party: "M",
    anforandetyp: "Svar",
    archetype: "EXPLAIN",
    title: "Under den här mandatperioden har antalet poliser nämligen",
    transcript: "Under den här mandatperioden har antalet poliser nämligen fortsatt att öka.",
    topic: "rättsväsende",
    durationS: 48.336,
    videoUrl:
      "https://riketnlooigm.b-cdn.net/clips/2026/06/HD10540_e0bb9ba6-5d6e-f111-bf27-6805cafeabf9_c01_540x960.mp4",
    thumbUrl:
      "https://riketnlooigm.b-cdn.net/thumbs/2026/06/HD10540_e0bb9ba6-5d6e-f111-bf27-6805cafeabf9_c01.webp",
    sourceTitle: "Lokal polisnärvaro och fler polisstationer",
    sourceUrl,
    debateDate: "2026-06-03",
    publishedAt: "2026-08-02T00:00:00Z",
    rank: 2,
    isSample: true
  },
  {
    id: "HD10540_e3bb9ba6-5d6e-f111-bf27-6805cafeabf9_c01",
    speechId: "HD10540_e3bb9ba6-5d6e-f111-bf27-6805cafeabf9",
    speakerName: "Mathias Tegnér",
    party: "S",
    anforandetyp: "Anförande",
    archetype: "QUOTABLE",
    title: "Jag hör vad ministern säger om fler poliser.",
    transcript: "Jag hör vad ministern säger om fler poliser.",
    topic: "polisstationer",
    durationS: 40.251,
    videoUrl:
      "https://riketnlooigm.b-cdn.net/clips/2026/06/HD10540_e3bb9ba6-5d6e-f111-bf27-6805cafeabf9_c01_540x960.mp4",
    thumbUrl:
      "https://riketnlooigm.b-cdn.net/thumbs/2026/06/HD10540_e3bb9ba6-5d6e-f111-bf27-6805cafeabf9_c01.webp",
    sourceTitle: "Lokal polisnärvaro och fler polisstationer",
    sourceUrl,
    debateDate: "2026-06-03",
    publishedAt: "2026-08-02T00:00:00Z",
    rank: 8,
    isSample: true
  },
  {
    id: "HD10540_e4bb9ba6-5d6e-f111-bf27-6805cafeabf9_c02",
    speechId: "HD10540_e4bb9ba6-5d6e-f111-bf27-6805cafeabf9",
    speakerName: "Gunnar Strömmer",
    party: "M",
    anforandetyp: "Svar",
    archetype: "CONFRONT",
    title: "Jag förstår att Mathias Tegnér vill avfärda all diskussion",
    transcript: "Jag förstår att Mathias Tegnér vill avfärda all diskussion om utvecklingen.",
    topic: "polisstationer",
    durationS: 60.74,
    videoUrl:
      "https://riketnlooigm.b-cdn.net/clips/2026/06/HD10540_e4bb9ba6-5d6e-f111-bf27-6805cafeabf9_c02_540x960.mp4",
    thumbUrl:
      "https://riketnlooigm.b-cdn.net/thumbs/2026/06/HD10540_e4bb9ba6-5d6e-f111-bf27-6805cafeabf9_c02.webp",
    sourceTitle: "Lokal polisnärvaro och fler polisstationer",
    sourceUrl,
    debateDate: "2026-06-03",
    publishedAt: "2026-08-02T00:00:00Z",
    rank: 9,
    isSample: true
  }
];

export function partyTint(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, 0.11)`;
}

export function partyInk(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? "#4A4A44" : hex;
}

export function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function normalizeParty(value: string | null | undefined): PartyCode {
  const party = (value ?? "").toUpperCase();
  return party in PARTIES ? (party as PartyCode) : "NONE";
}
