import type { AppRoute } from "../navigation";

export type DesktopRouteId =
  | "home"
  | "clip"
  | "following"
  | "search"
  | "profile"
  | "person"
  | "person-clips"
  | "party"
  | "party-clips"
  | "saved"
  | "saved-clips"
  | "legal";

export type DesktopRouteDescriptor = {
  id: DesktopRouteId;
  focusKey: string;
  available: boolean;
  eyebrow: string;
  title: string;
  description: string;
  backAction: "history" | "home";
};

const TAB_DESCRIPTORS = {
  foljer: {
    id: "following",
    title: "Följer",
    description: "Dina följda politiker och partier."
  },
  sok: {
    id: "search",
    title: "Sök",
    description: "Sök bland personer, partier och politiska ämnen."
  },
  profil: {
    id: "profile",
    title: "Profil",
    description: "Konto, sparade klipp och personliga inställningar."
  }
} as const;

const LEGAL_TITLES = {
  terms: "Villkor",
  privacy: "Integritet",
  storage: "Lagring",
  about: "Om Pleni"
} as const;

function unreachable(route: never): never {
  throw new Error(`Unhandled desktop route: ${JSON.stringify(route)}`);
}

/**
 * Describe every public route before it reaches the desktop presentation.
 * Later UI20 chunks replace individual pending surfaces without adding a
 * second router or changing the static-host-safe hashes.
 */
export function describeDesktopRoute(route: AppRoute): DesktopRouteDescriptor {
  switch (route.view) {
    case "clip":
      return {
        id: "clip",
        focusKey: `clip:${route.clipId}`,
        available: true,
        eyebrow: "Pleni",
        title: "Videoklipp",
        description: "Klippet du öppnade, följt av fler aktuella riksdagsklipp.",
        backAction: "history"
      };
    case "tab": {
      if (route.tab === "hem") {
        return {
          id: "home",
          focusKey: `home:${route.feedMode}`,
          available: true,
          eyebrow: "Pleni",
          title: "Videoflöde",
          description: "",
          backAction: "home"
        };
      }
      const descriptor = TAB_DESCRIPTORS[route.tab];
      return {
        ...descriptor,
        focusKey: `tab:${route.tab}`,
        available: route.tab === "sok" || route.tab === "foljer" || route.tab === "profil",
        eyebrow: "Pleni på desktop",
        backAction: "home"
      };
    }
    case "person":
      return {
        id: "person",
        focusKey: `person:${route.personId}`,
        available: true,
        eyebrow: "Politiker",
        title: "Politiker",
        description: "Profil, uppdrag och publicerade klipp.",
        backAction: "history"
      };
    case "person-clips":
      return {
        id: "person-clips",
        focusKey: `person-clips:${route.personId}:${route.startId ?? "first"}`,
        available: true,
        eyebrow: "Politiker",
        title: "Politikerns klipp",
        description: "Fokuserad klippsamling.",
        backAction: "history"
      };
    case "party":
      return {
        id: "party",
        focusKey: `party:${route.partyCode}`,
        available: true,
        eyebrow: "Parti",
        title: "Parti",
        description: "Partiets politiker och publicerade klipp.",
        backAction: "history"
      };
    case "party-clips":
      return {
        id: "party-clips",
        focusKey: `party-clips:${route.partyCode}:${route.startId ?? "first"}`,
        available: true,
        eyebrow: "Parti",
        title: "Partiets klipp",
        description: "Fokuserad klippsamling.",
        backAction: "history"
      };
    case "saved":
      return {
        id: "saved",
        focusKey: "saved",
        available: true,
        eyebrow: "Ditt bibliotek",
        title: "Sparade klipp",
        description: "Ditt sparade arkiv.",
        backAction: "history"
      };
    case "saved-clips":
      return {
        id: "saved-clips",
        focusKey: `saved-clips:${route.startId ?? "first"}`,
        available: true,
        eyebrow: "Ditt bibliotek",
        title: "Sparade klipp",
        description: "Fokuserad uppspelning av ditt sparade arkiv.",
        backAction: "history"
      };
    case "legal":
      return {
        id: "legal",
        focusKey: `legal:${route.page}`,
        available: true,
        eyebrow: "Pleni",
        title: LEGAL_TITLES[route.page],
        description: "Juridisk information från Pleni.",
        backAction: "history"
      };
    default:
      return unreachable(route);
  }
}
