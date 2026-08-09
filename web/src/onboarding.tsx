import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, Fingerprint, ShieldCheck, Sparkles, User } from "lucide-react";

import { PARTIES } from "./data";
import type { OnboardingState, PartyCode } from "./types";

/**
 * Three-step onboarding, shown once per signed-in account and re-openable from
 * Profil. Anonymous visitors never see this flow.
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
 * 1. **Only offered processing is shown.** This release offers personalisation
 *    only. Analytics and email are neither collected nor presented as choices.
 *    Terms are linked at account creation; the privacy notice is information,
 *    not a bundled acceptance. Personalisation defaults to off.
 * 2. **Onboarding can be skipped.** The design gated the whole app behind
 *    accepting terms. `A-9` and decision 3 of the launch plan both require the
 *    non-personalised `Senaste` feed to stay fully usable without consent —
 *    consent obtained as the price of entry is not "freely given" under IMY's
 *    guidance, so it would not be valid consent at all.
 */

const PARTY_ORDER: PartyCode[] = ["V", "S", "MP", "C", "L", "KD", "M", "SD"];

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
  const [done, setDone] = useState(false);

  const toggleParty = (party: PartyCode) =>
    setParties((current) =>
      current.includes(party) ? current.filter((p) => p !== party) : [...current, party]
    );

  /**
   * `granted` is passed explicitly so enabling personalisation is an
   * affirmative act rather than a pre-set state. The distinction is the whole
   * legal test: a switch already on when the screen loads is not consent,
   * because the user did nothing; a button they press that enables it is.
   *
   * Nothing here is bundled. Personalisation is granted on its own and gives
   * the personalised feed on its own. Analytics and email remain false because
   * neither purpose is offered in the current product.
   */
  const finish = (granted: OnboardingState["consent"]) => {
    onComplete({
      leaning,
      parties,
      consent: granted,
      // Account creation presents the current terms before Clerk opens. This
      // local marker is UI state, not the future F1 consent ledger.
      acceptedTerms: true,
      completedAt: new Date().toISOString()
    });
    setConsent(granted);
    setDone(true);
  };

  if (done) {
    return (
      <div className="onboarding-backdrop">
        <div
          className="onboarding-card onboarding-card--done"
          role="dialog"
          aria-modal="true"
          aria-label="Välkommen till Pleni"
        >
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
      <div
        className={`onboarding-card onboarding-card--step-${step}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Onboarding, steg ${step} av 3`}
      >
        <div className="onboarding-progress">
          <div className="onboarding-progress-start">
            {step > 1 && (
              <button
                type="button"
                className="onboarding-back"
                aria-label="Föregående steg"
                onClick={() => setStep((s) => Math.max(1, s - 1))}
              >
                <ArrowLeft size={15} />
              </button>
            )}
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
                      <span className="party-chip" style={{ background: party.color }}>
                        {code}
                      </span>
                      <span className="party-tile-name">{party.name}</span>
                      <span className="party-tile-check">
                        {selected && <Check size={14} />}
                      </span>
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
              <h2>Ditt flöde, ditt val</h2>
              <p className="onboarding-lede">
                Dina val sparas bara på den här enheten. Utan personalisering ser du{" "}
                <strong>Senaste</strong> — alla klipp, senaste först.
              </p>

              <div className="onboarding-age-note">
                <strong>Konto och ålder</strong>
                <span>
                  Om du är under 13 år behöver du din vårdnadshavares tillstånd för att
                  använda ett konto.
                </span>
              </div>

              <div className="consent-choice">
                <button
                  type="button"
                  className="onboarding-primary"
                  onClick={() => finish({ personal: true, analytics: false, email: false })}
                >
                  Slå på personalisering
                </button>
                <button
                  type="button"
                  className="onboarding-primary onboarding-primary--ghost"
                  onClick={() => finish({ personal: false, analytics: false, email: false })}
                >
                  Fortsätt utan
                </button>
              </div>

              <p className="onboarding-fineprint">
                Du kan stänga av personalisering när som helst under Profil. Villkor och
                integritetsinformation finns alltid där.
              </p>
            </div>
          )}

          {step < 3 && (
            <div className="onboarding-actions">
              <button
                type="button"
                className="onboarding-primary"
                onClick={() => setStep((s) => Math.min(3, s + 1))}
              >
                Nästa steg <ArrowRight size={16} />
              </button>
            </div>
          )}

          {step < 3 && (
            <button type="button" className="onboarding-skip" onClick={onSkip}>
              Hoppa över — visa Senaste
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
