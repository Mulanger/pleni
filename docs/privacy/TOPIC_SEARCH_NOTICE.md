# Topic-search privacy copy — gated beta

Prepared 2026-08-25 and updated 2026-08-26. The short warning is live only in
the signed-in owner Android beta and requires confirmation before the first
submitted search in each page session. The longer public-notice section remains
a draft for a future general launch.

## Short copy beside the search action

> När du söker på ett ämne hjälper OpenAI oss att hitta relevanta klipp. Skriv
> inte personuppgifter eller annan privat information i sökfältet.

## Privacy-notice section

### Ämnessökning

När du skickar en ämnessökning behandlar Pleni söktexten för att hitta relevanta
klipp i riksdagens offentliga material. Den del som beskriver ämnet skickas till
OpenAI för att omvandlas till en matematisk sökrepresentation. Vi skickar inte
ditt Pleni-konto eller din råa nätverksadress till OpenAI.

Pleni sparar inte söktexten eller sökrepresentationen, kopplar inte sökningen
till ditt konto och använder den inte för annonser, rekommendationsprofilering
eller modellträning. För att motverka missbruk sparar vi bara en daglig
envägskod av nätverksadressen tillsammans med räknare och tidsgränser. De
posterna löper ut efter 48 timmar.

OpenAI uppger att API-data inte används för att träna deras modeller om kunden
inte aktivt väljer det. Deras normala missbruksloggar kan sparas i upp till 30
dagar; särskilda kontroller kan ge kortare eller ingen sådan lagring. Före
lansering ska Pleni verifiera vilken region och lagring som faktiskt gäller för
det här projektet. Läs mer i OpenAI:s
[API-datahantering](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint).

Skriv inte personuppgifter, hälsouppgifter eller annan privat information i
sökfältet. Kontakta `kontakt@pleni.se` om du har frågor om behandlingen.

## Approval record

- Engineering accuracy review: complete 2026-08-25.
- Actual OpenAI project region/retention evidence: **pending**.
- Controller identity/public legal notice blocker: **pending**, unchanged from
  the main privacy pack.
- Owner approval: limited signed-in Android beta approved 2026-08-26; general
  viewer launch remains pending.
