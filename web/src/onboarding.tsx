import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, Fingerprint, ShieldCheck, Sparkles, User } from "lucide-react";

import { PARTIES } from "./data";
import type { OnboardingState, PartyCode } from "./types";

/**
 * Three-step onboarding, shown once and re-openable from Profil.
 *
 * **Everything here stays on the device.** `C-5` allows exactly this and no
 * more: "Until the user actively grants, party choices stay local and no watch
 * history or inferred state is transmitted or persisted." The private schema
 * (`C-1`), the consent ledger (`C-2`) and the F0 documents do not exist yet, so
 * there is nowhere lawful to send any of it. `persistOnboarding` writes to
 * `localStorage` and nothing else — see `web/src/onboarding-store.ts`.
 *
 * Two deliberate departures from the supplied design, both required by
 * `docs/RECOMMENDATION_PREREQUISITES.md`:
 *
 * 1. **Consent is granular, not one checkbox.** `C-4` is a GATE:
 *    "Personalization, analytics, email, model-training reuse are four
 *    independent consents. One 'improve my experience' switch is not specific
 *    enough." Accepting the terms is therefore separated from agreeing to be
 *    profiled, and each purpose is its own switch, all defaulting to off.
 * 2. **Onboarding can be skipped.** The design gated the whole app behind
 *    accepting terms. `A-9` and decision 3 of the launch plan both require the
 *    non-personalised `Senaste` feed to stay fully usable without consent —
 *    consent obtained as the price of entry is not "freely given" under IMY's
 *    guidance, so it would not be valid consent at all.
 */

const PARTY_ORDER: PartyCode[] = ["V", "S", "MP", "C", "L", "KD", "M", "SD"];

const CONSENT_PURPOSES = [
  {
    key: "personal" as const,
    title: "Personaliserat flöde",
    help: "Använder dina val och ditt tittande för att välja klipp åt dig."
  },
  {
    key: "analytics" as const,
    title: "Analys & statistik",
    help: "Hjälper oss förstå vad som fungerar i appen."
  },
  {
    key: "email" as const,
    title: "Aviseringar via e-post",
    help: "Nya klipp från personer och partier du följer."
  }
];

export function Onboarding({
  initial,
  onComplete,
  onSkip
}: {
  initial: OnboardingState;
  onComplete: (state: OnboardingState) => void;
  onSkip: () => void;
}) {
  const [step, setStep] = useState(1);
  const [leaning, setLeaning] = useState(initial.leaning);
  const [parties, setParties] = useState<PartyCode[]>(initial.parties);
  const [consent, setConsent] = useState(initial.consent);
  const [acceptedTerms, setAcceptedTerms] = useState(initial.acceptedTerms);
  const [done, setDone] = useState(false);

  const toggleParty = (party: PartyCode) =>
    setParties((current) =>
      current.includes(party) ? current.filter((p) => p !== party) : [...current, party]
    );

  const anyConsent = consent.personal || consent.analytics || consent.email;

  /**
   * `granted` is passed explicitly so "Slå på allt" is a single affirmative act
   * rather than a pre-set state. The distinction is the whole legal test: a
   * switch already on when the screen loads is not consent, because the user
   * did nothing; a button they press that turns three switches on is.
   *
   * Nothing here is bundled. Personalisation is granted on its own and gives
   * the personalised feed on its own — `C-4` requires the four purposes to be
   * independent, and Article 7(4) treats consent to unrelated processing as a
   * condition of service as a strong sign it was not freely given.
   */
  const finish = (granted: OnboardingState["consent"]) => {
    onComplete({
      leaning,
      parties,
      consent: granted,
      acceptedTerms,
      completedAt: new Date().toISOString()
    });
    setConsent(granted);
    setDone(true);
  };

  if (done) {
    return (
      <div className="onboarding-backdrop">
        <div className="onboarding-card onboarding-card--done">
          <div className="onboarding-badge">
            <Sparkles size={28} />
          </div>
          <h2>Välkommen till Pleni</h2>
          <p>
            {consent.personal
              ? "Ditt flöde anpassas efter dina val. Du kan stänga av det när som helst under Profil."
              : "Du ser Senaste — alla klipp, senaste först. Slå på personalisering under Profil när du vill."}
          </p>
          <button className="onboarding-primary" onClick={onSkip}>
            Börja titta
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding-backdrop">
      <div className="onboarding-card">
        <div className="onboarding-progress">
          <div className="onboarding-bars">
            {[1, 2, 3].map((index) => (
              <span
                key={index}
                className={
                  index === step
                    ? "onboarding-bar onboarding-bar--active"
                    : index < step
                      ? "onboarding-bar onboarding-bar--done"
                      : "onboarding-bar"
                }
              />
            ))}
          </div>
          <span className="onboarding-step">Steg {step} av 3</span>
        </div>

        <div className="onboarding-body">
          {step === 1 && (
            <div className="onboarding-pane">
              <span className="onboarding-icon">
                <User size={22} />
              </span>
              <h2>Var står du politiskt?</h2>
              <p className="onboarding-lede">
                Frivilligt. Det hjälper oss föreslå klipp, och svaret lämnar aldrig din enhet
                förrän du slår på personalisering.
              </p>

              <div className="leaning">
                <div className="leaning-track">
                  <span className="leaning-centre" />
                  <span
                    className={
                      leaning < 50
                        ? "leaning-fill leaning-fill--left"
                        : leaning > 50
                          ? "leaning-fill leaning-fill--right"
                          : "leaning-fill"
                    }
                    style={{
                      left: `${Math.min(leaning, 50)}%`,
                      width: `${Math.abs(leaning - 50)}%`
                    }}
                  />
                  <span className="leaning-thumb" style={{ left: `calc(${leaning}% - 13px)` }} />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={leaning}
                    aria-label="Politisk inriktning från vänster till höger"
                    onChange={(event) => setLeaning(Number(event.target.value))}
                  />
                </div>
                <div className="leaning-labels">
                  <span className={leaning < 50 ? "is-on" : ""}>Vänster</span>
                  <span className={leaning === 50 ? "is-on" : ""}>Mitten</span>
                  <span className={leaning > 50 ? "is-on" : ""}>Höger</span>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="onboarding-pane">
              <span className="onboarding-icon">
                <Fingerprint size={22} />
              </span>
              <h2>Vilka partier vill du följa?</h2>
              <p className="onboarding-lede">
                Välj de partier du vill se mer av. Du kan ändra det när som helst.
              </p>
              <div className="party-grid">
                {PARTY_ORDER.map((code) => {
                  const party = PARTIES[code];
                  const selected = parties.includes(code);
                  return (
                    <button
                      key={code}
                      type="button"
                      aria-pressed={selected}
                      className={selected ? "party-tile party-tile--on" : "party-tile"}
                      onClick={() => toggleParty(code)}
                    >
                      <span className="party-tile-top">
                        <span className="party-chip" style={{ background: party.color }}>
                          {code}
                        </span>
                        {selected && <Check size={16} />}
                      </span>
                      <span className="party-tile-name">{party.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="onboarding-pane">
              <span className="onboarding-icon">
                <ShieldCheck size={22} />
              </span>
              <h2>Villkor & samtycke</h2>
              <p className="onboarding-lede">
                Dina partival och din politiska inriktning räknas som känsliga personuppgifter.
                Därför frågar vi separat om varje sak — och allt är avstängt tills du slår på det.
              </p>

              <label className="terms-row">
                <span className={acceptedTerms ? "tick tick--on" : "tick"}>
                  {acceptedTerms && <Check size={14} />}
                </span>
                <span>Jag har läst och godkänner användarvillkoren och integritetspolicyn.</span>
                <input
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(event) => setAcceptedTerms(event.target.checked)}
                />
              </label>

              {/* The consequence is stated here, beside both choices, rather
                  than in a dialog after someone declines. EDPB Guidelines
                  03/2022 name "questioning a refusal to grant consent" as a
                  deceptive pattern — continuous prompting — because a user may
                  simply give in to the second ask. Saying it once, up front and
                  neutrally, is the informed half of informed consent; saying it
                  again afterwards is pressure. */}
              <p className="consent-consequence">
                Personaliserat flöde kräver att du slår på personalisering. Utan den ser du{" "}
                <strong>Senaste</strong> — alla klipp, senaste först.
              </p>

              <div className="consent-list">
                {CONSENT_PURPOSES.map((purpose) => (
                  <label key={purpose.key} className="consent-row">
                    <span className="consent-copy">
                      <strong>{purpose.title}</strong>
                      <small>{purpose.help}</small>
                    </span>
                    <span className={consent[purpose.key] ? "switch switch--on" : "switch"}>
                      <span className="switch-dot" />
                    </span>
                    <input
                      type="checkbox"
                      checked={consent[purpose.key]}
                      onChange={() =>
                        setConsent((current) => ({
                          ...current,
                          [purpose.key]: !current[purpose.key]
                        }))
                      }
                    />
                  </label>
                ))}
              </div>

              <p className="onboarding-fineprint">
                Personalisering fungerar på egen hand — analys och e-post är frivilliga och
                påverkar inte ditt flöde. Inget skickas till våra servrar än.
              </p>
            </div>
          )}

          <div className="onboarding-actions">
            {step > 1 && (
              <button
                type="button"
                className="onboarding-back"
                aria-label="Föregående steg"
                onClick={() => setStep((s) => Math.max(1, s - 1))}
              >
                <ArrowLeft size={18} />
              </button>
            )}
            {step < 3 ? (
              <button
                type="button"
                className="onboarding-primary"
                onClick={() => setStep((s) => Math.min(3, s + 1))}
              >
                Nästa steg <ArrowRight size={16} />
              </button>
            ) : (
              // Two buttons of equal weight. Regulators have been consistent
              // since the cookie-banner enforcement that "accept all" must not
              // be easier to reach than the refusal, so these share a class and
              // differ only in fill.
              <div className="consent-choice">
                <button
                  type="button"
                  className="onboarding-primary"
                  disabled={!acceptedTerms}
                  onClick={() => finish({ personal: true, analytics: true, email: true })}
                >
                  Slå på allt
                </button>
                <button
                  type="button"
                  className="onboarding-primary onboarding-primary--ghost"
                  disabled={!acceptedTerms}
                  onClick={() => finish(consent)}
                >
                  {anyConsent ? "Spara mina val" : "Fortsätt utan"}
                </button>
              </div>
            )}
          </div>

          <button type="button" className="onboarding-skip" onClick={onSkip}>
            Hoppa över — visa Senaste
          </button>
        </div>
      </div>
    </div>
  );
}
