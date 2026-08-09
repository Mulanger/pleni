export const LEGAL_VERSION = "2026-08-09";

export type LegalPageId = "terms" | "privacy" | "storage" | "about";

export interface LegalLink {
  label: string;
  href: string;
}

export interface LegalSection {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  links?: LegalLink[];
}

export interface LegalPage {
  id: LegalPageId;
  shortTitle: string;
  title: string;
  summary: string;
  sections: LegalSection[];
}

export const LEGAL_PAGE_ORDER: LegalPageId[] = ["terms", "privacy", "storage", "about"];

export const LEGAL_PAGES: Record<LegalPageId, LegalPage> = {
  terms: {
    id: "terms",
    shortTitle: "Villkor",
    title: "Användarvillkor",
    summary: "Reglerna för att använda Pleni, skapa konto och delta i kommentarer.",
    sections: [
      {
        title: "1. Om tjänsten",
        paragraphs: [
          "Pleni gör offentliga svenska riksdagsdebatter lättare att upptäcka i ett mobilanpassat videoformat. Tjänsten är fristående och är inte en del av eller företrädare för Sveriges riksdag.",
          "Pleni är kostnadsfritt i den här versionen. Du kan titta på det offentliga flödet utan konto. Ett konto behövs för bland annat kommentarer, följningar och sparade klipp."
        ]
      },
      {
        title: "2. Konto och ålder",
        paragraphs: [
          "Du ansvarar för att uppgifterna du lämnar till kontot är riktiga och för att skydda din inloggning. Om du är under 13 år behöver du din vårdnadshavares tillstånd för att använda ett konto. Pleni begär inte födelsedatum eller identitetshandling för detta.",
          "Genom att skapa och använda ett konto godkänner du dessa villkor. Integritetsinformationen beskriver personuppgiftsbehandlingen men är inte ett avtal som du behöver godkänna."
        ]
      },
      {
        title: "3. Kommentarer och uppförande",
        paragraphs: [
          "Kommentarer publiceras med ditt valda användarnamn. Du ansvarar för det du skriver och ger Pleni rätt att lagra, visa och moderera kommentaren i den omfattning som krävs för kommentarsfunktionen."
        ],
        bullets: [
          "Publicera inte hot, hat, trakasserier eller olagligt innehåll.",
          "Publicera inte någon annans privata uppgifter.",
          "Spamma inte och försök inte kringgå tekniska skydd eller avstängningar.",
          "Utge dig inte för att vara en annan person, myndighet eller organisation."
        ]
      },
      {
        title: "4. Moderering och anmälan",
        paragraphs: [
          "Du kan anmäla en kommentar direkt i kommentarsmenyn. Pleni får dölja eller radera innehåll och begränsa kommentarsfunktionen när det behövs för säkerhet, lag, dessa villkor eller en fungerande diskussion.",
          "För att anmäla annat innehåll, begära en förklaring eller invända mot ett modereringsbeslut, mejla kontakt@pleni.se och ange klipp eller kommentar samt skälet till din begäran."
        ],
        links: [{ label: "Kontakta Pleni", href: "mailto:kontakt@pleni.se" }]
      },
      {
        title: "5. Material och källor",
        paragraphs: [
          "Debattmaterial och faktauppgifter hämtas från Sveriges riksdag. Källan anges i appen. Pleni kan bearbeta, beskära och välja utdrag för mobil visning, men garanterar inte att ett klipp återger hela debatten eller allt sammanhang.",
          "Använd källänken till riksdagen.se när du behöver kontrollera originalet. Rättigheter till källmaterial, porträtt, namn och kännetecken tillhör respektive rättighetshavare."
        ]
      },
      {
        title: "6. Tillgänglighet och ansvar",
        paragraphs: [
          "Pleni får förändra eller tillfälligt stänga funktioner av tekniska, säkerhetsmässiga eller juridiska skäl. Vi försöker hålla uppgifter och länkar aktuella men kan inte lova att tjänsten alltid är felfri eller tillgänglig.",
          "Använd inte Pleni som enda källa för beslut med rättsliga, ekonomiska eller andra betydande konsekvenser."
        ]
      },
      {
        title: "7. Ändringar och kontakt",
        paragraphs: [
          "Den version och det datum som visas högst upp gäller för dessa villkor. Väsentliga ändringar ska beskrivas tydligt i tjänsten innan de börjar gälla för konton.",
          "Frågor om villkoren skickas till kontakt@pleni.se."
        ],
        links: [{ label: "kontakt@pleni.se", href: "mailto:kontakt@pleni.se" }]
      }
    ]
  },
  privacy: {
    id: "privacy",
    shortTitle: "Integritet",
    title: "Integritetsinformation",
    summary: "Vilka uppgifter Pleni behandlar, varför de behövs och vilka rättigheter du har.",
    sections: [
      {
        title: "Personuppgiftsansvarig och kontakt",
        paragraphs: [
          "Pleni är tjänstens namn. Ett framtida bolag planeras under namnet Pleni AB, men bolaget är ännu inte registrerat och anges därför inte som juridisk person. Fullständigt juridiskt namn, organisationsnummer, säte och etableringsadress publiceras när bolaget har registrerats.",
          "Frågor och begäranden om personuppgifter skickas till kontakt@pleni.se. Avsaknaden av färdiga bolagsuppgifter är en känd juridisk informationslucka och döljs inte i denna text."
        ],
        links: [{ label: "kontakt@pleni.se", href: "mailto:kontakt@pleni.se" }]
      },
      {
        title: "När du tittar utan konto",
        paragraphs: [
          "Pleni skapar ingen anonym tittarprofil och har ingen egen analys- eller annonsspårning i den här versionen. Appen hämtar sin kod från webbhotellet och video samt bilder från Bunny CDN. Dessa leverantörer kan behandla tekniska begäransuppgifter som IP-adress, tidpunkt, webbläsare, land och den fil eller adress som begärs för leverans, felsökning och säkerhet.",
          "Videospelaren använder aktuell tid och synlighet för uppspelning i webbläsaren. Pleni skickar eller sparar inte din tittarhistorik i en egen användarprofil i den här versionen."
        ]
      },
      {
        title: "När du skapar konto",
        paragraphs: [
          "Clerk hanterar registrering, inloggning och sessioner. Beroende på vad du själv lämnar kan uppgifterna omfatta Clerk-användar-id, e-postadress, namn, användarnamn, profilbild, inloggningsmetod samt säkerhets- och sessionsuppgifter.",
          "Ändamålet är att skapa och skydda ditt konto och ge tillgång till kontofunktioner. Den rättsliga grunden är att tillhandahålla den kontotjänst du begär och, för säkerhet och missbruksförebyggande, Plenis berättigade intresse av en säker tjänst."
        ],
        links: [
          { label: "Clerks integritetspolicy", href: "https://clerk.com/legal/privacy" },
          { label: "Clerks dataskyddsavtal", href: "https://clerk.com/legal/dpa" }
        ]
      },
      {
        title: "Val och bibliotek på din enhet",
        paragraphs: [
          "Efter inloggning kan politisk inriktning, valda partier, personaliseringsval, följningar, gillningar och sparade klipp lagras i webbläsarens localStorage. Nycklarna skiljs åt med ditt Clerk-användar-id så att konton på samma enhet inte delar bibliotek.",
          "Uppgifterna skickas inte till Plenis databas i den här versionen. Val för personalisering sparas först när du aktivt väljer det. Du kan stänga av personalisering eller rensa webbplatsdata i webbläsaren."
        ]
      },
      {
        title: "Kommentarer och anmälningar",
        paragraphs: [
          "Supabase lagrar ditt privata Clerk-användar-id tillsammans med valt kommentarsnamn, kommentar, klipp-id och tidpunkt. Andra ser användarnamn, kommentar och tidpunkt men inte ditt Clerk-id eller din e-postadress.",
          "En anmälan kan innehålla kommentar, vald anledning, tidpunkt och – när du är inloggad – ditt Clerk-id. Modereringsåtgärder och avstängningar dokumenteras för att hantera missbruk och invändningar. Behandlingen behövs för kommentarsfunktionen och Plenis berättigade intresse av säkerhet och moderering."
        ],
        links: [{ label: "Supabase dataskyddsavtal", href: "https://supabase.com/legal/dpa" }]
      },
      {
        title: "Offentliga uppgifter om politiker",
        paragraphs: [
          "Pleni behandlar namn, parti, roll, porträtt, anföranden och annan offentlig yrkesinformation om politiker från Sveriges riksdag. Ändamålet är att informera om parlamentarisk verksamhet. Källan är offentlig och anges i tjänsten."
        ]
      },
      {
        title: "Mottagare och överföringar",
        paragraphs: [
          "Pleni använder Clerk för identitet, Supabase för publicerade klippmetadata och kommentarer, Bunny för media och CDN samt InstaPods för den statiska webbappen. Leverantörerna och deras underleverantörer kan behandla uppgifter inom och utanför EES.",
          "Clerk beskriver EU–USA Data Privacy Framework och EU:s standardavtalsklausuler som överföringsmekanismer. Övriga leverantörers aktuella avtal, regioner och underleverantörer ska verifieras i den interna leverantörsförteckningen; du kan begära aktuell information via kontaktadressen."
        ],
        links: [
          { label: "Clerks dataskyddsavtal", href: "https://clerk.com/legal/dpa" },
          { label: "Bunny GDPR", href: "https://bunny.net/gdpr/" },
          { label: "Bunnys underleverantörer", href: "https://bunny.net/gdpr/sub-processors/" }
        ]
      },
      {
        title: "Hur länge uppgifterna finns kvar",
        bullets: [
          "Enhetslokala val finns kvar tills du rensar dem i Pleni eller webbläsaren.",
          "Kontouppgifter behandlas medan kontot finns och därefter enligt Clerks nödvändiga säkerhets-, backup- och rättsliga perioder.",
          "En offentlig kommentar finns kvar tills du tar bort den eller Pleni modererar den. Raderad kommentarstext töms, medan en minimal post kan finnas kvar för databasens integritet och modereringshistorik.",
          "Anmälningar och modereringshändelser sparas så länge de behövs för att hantera ärendet, missbruk, invändningar eller rättsliga anspråk.",
          "Tekniska leverans- och säkerhetsloggar följer respektive leverantörs konfiguration och nödvändiga säkerhetsperiod."
        ]
      },
      {
        title: "Dina rättigheter",
        paragraphs: [
          "Du kan, när GDPR är tillämplig, begära tillgång, rättelse, radering, begränsning och dataportabilitet samt invända mot behandling som bygger på berättigat intresse. Du kan när som helst återkalla ett personaliseringsval utan att tidigare behandling blir olaglig.",
          "Mejla kontakt@pleni.se. Vi kan behöva kontrollera att begäran gäller rätt konto. Du har också rätt att klaga hos Integritetsskyddsmyndigheten, IMY."
        ],
        links: [
          { label: "Kontakta Pleni", href: "mailto:kontakt@pleni.se" },
          { label: "Integritetsskyddsmyndigheten", href: "https://www.imy.se/" }
        ]
      }
    ]
  },
  storage: {
    id: "storage",
    shortTitle: "Cookies",
    title: "Cookies och lokal lagring",
    summary: "Vad som sparas i webbläsaren och varför Pleni inte visar en generell cookiebanner.",
    sections: [
      {
        title: "Plenis princip",
        paragraphs: [
          "Pleni använder inte cookies eller lokal lagring för annonsering och har ingen egen webbanalys i den här versionen. Vi visar därför inte en generell cookiebanner för anonyma besökare.",
          "Lagring som behövs för inloggning eller en funktion du själv begär används för just det ändamålet. Valfri personalisering är avstängd tills du aktivt slår på den."
        ]
      },
      {
        title: "Clerk – nödvändig inloggning",
        paragraphs: [
          "När du använder konto- eller inloggningsfunktioner sätter Clerk nödvändiga säkerhets- och sessionscookies. De kan bland annat heta __session, __client, __client_uat och _cfuvid. Exakta cookies kan bero på Clerk-konfiguration och säkerhetsflöde.",
          "__session innehåller en kortlivad signerad sessionstoken som förnyas under en aktiv session. Övriga Clerk-cookies håller ihop klienten, visar när sessionen uppdaterats och skyddar Clerk-tjänsten mot missbruk. De kan inte stängas av utan att inloggningen slutar fungera."
        ],
        links: [{ label: "Så använder Clerk cookies", href: "https://clerk.com/docs/guides/how-clerk-works/cookies" }]
      },
      {
        title: "Pleni – localStorage",
        bullets: [
          "riket.onboarding.v1:<konto-id> – dina frivilliga onboardingval, personaliseringsstatus och när flödet slutfördes eller hoppades över. Sparas tills du ändrar eller rensar valet.",
          "riket.library.v1:<konto-id> – följda personer och partier samt gillade och sparade klipp. Uppdateras när du använder funktionen och finns kvar tills den rensas.",
          "Äldre ospecificerade nycklar kan finnas kvar från tidigare versioner men läses inte in i ett nytt konto."
        ]
      },
      {
        title: "Så ändrar eller rensar du",
        paragraphs: [
          "Personalisering kan stängas av under Profil. Webbläsarens inställningar kan radera Plenis webbplatsdata och Clerk-cookies. Då loggas du ut och lokala intressen, följningar, gillningar och sparade klipp kan försvinna från den enheten.",
          "Om Pleni inför analys, marknadsföring eller annan lagring som inte är nödvändig kommer den att vara avstängd tills ett separat val har gjorts, och det ska vara lika enkelt att tacka nej som ja."
        ]
      }
    ]
  },
  about: {
    id: "about",
    shortTitle: "Om & kontakt",
    title: "Om Pleni och kontakt",
    summary: "Vem som står bakom tjänsten, var materialet kommer från och hur du når oss.",
    sections: [
      {
        title: "Pleni",
        paragraphs: [
          "Pleni är en fristående mobil videotjänst för svenska riksdagsdebatter. Målet är att göra offentliga anföranden lättare att hitta och ta del av utan att ersätta originalkällan.",
          "Pleni är inte en del av, finansierad av eller officiellt godkänd av Sveriges riksdag eller något politiskt parti."
        ]
      },
      {
        title: "Juridisk status",
        paragraphs: [
          "Pleni används som tjänstenamn. Ett aktiebolag planeras under namnet Pleni AB men är ännu inte registrerat. Därför finns ännu inget organisationsnummer, registrerat säte eller bolagsadress att publicera.",
          "När bolaget har registrerats uppdateras den här sidan med exakt registrerat företagsnamn, organisationsnummer, säte och etableringsadress. Pleni AB anges inte som nuvarande juridisk operatör innan dess."
        ]
      },
      {
        title: "Kontakt",
        bullets: [
          "Allmänna frågor: kontakt@pleni.se",
          "Integritet och personuppgifter: kontakt@pleni.se",
          "Olagligt innehåll, rättigheter och modereringsbeslut: kontakt@pleni.se"
        ],
        links: [{ label: "Skicka mejl", href: "mailto:kontakt@pleni.se" }]
      },
      {
        title: "Källa och redaktionell hantering",
        paragraphs: [
          "Videor, anföranden och grundläggande politikuppgifter kommer från Sveriges riksdag. Pleni väljer och bearbetar korta utdrag maskinellt och genom operatörsgranskning. Ett klipp kan därför inte ersätta debattens fullständiga sammanhang.",
          "Profilporträtt speglas från den officiella källan för stabil leverans och krediteras Sveriges riksdag i appen."
        ],
        links: [{ label: "Sveriges riksdag", href: "https://www.riksdagen.se/" }]
      },
      {
        title: "Anmäl innehåll eller begär rättelse",
        paragraphs: [
          "Använd kommentarsmenyn för att rapportera en kommentar. För klipp, personuppgifter, rättigheter eller andra frågor: mejla länken till innehållet, beskriv problemet och ange hur vi kan återkomma.",
          "Pleni granskar begäran och kan rätta metadata, dölja en kommentar eller avpublicera ett klipp medan frågan utreds."
        ],
        links: [{ label: "kontakt@pleni.se", href: "mailto:kontakt@pleni.se" }]
      }
    ]
  }
};
