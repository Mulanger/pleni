import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, Fingerprint, ShieldCheck, Sparkles, X } from "lucide-react";

import { PARTIES } from "./data";
import type { OnboardingState, PartyCode } from "./types";

/**
 * Two-step consent onboarding, shown once per signed-in account. Profil opens
 * the separate one-step interest editor, so an existing grant is not requested
 * again. Anonymous visitors never see either account flow.
 *
 * Party choices remain on the device until the viewer actively grants
 * personalisation. In the recommendation rollout, that grant stores only the
 * explicitly selected parties plus followed parties/politicians in the private
 * recommendation schema. Watch history is not sent or used by this first
 * rule-based version. The former left/right self-placement question was removed
 * because V1 has no approved or reliable ideological-to-content mapping.
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
 *    non-personalised experience to stay fully usable without consent —
 *    consent obtained as the price of entry is not "freely given" under IMY's
 *    guidance, so it would not be valid consent at all.
 */

const PARTY_ORDER: PartyCode[] = ["V", "S", "MP", "C", "L", "KD", "M", "SD"];

export function Onboarding({
  initial,
  onComplete,
  onSkip,
  mode = "consent",
  recommendationsConnected = false
}: {
  initial: OnboardingState;
  onComplete: (state: OnboardingState) => void | Promise<void>;
  onSkip: () => void;
  mode?: "consent" | "interests";
  recommendationsConnected?: boolean;
}) {
  const editingInterests = mode === "interests";
  const [step, setStep] = useState(1);
  const [parties, setParties] = useState<PartyCode[]>(initial.parties);
  const [consent, setConsent] = useState(initial.consent);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

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
  const finish = async (granted: OnboardingState["consent"]) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onComplete({
        parties,
        consent: granted,
        // Account creation presents the current terms before Clerk opens. This
        // local marker is UI state, not the future F1 consent ledger.
        acceptedTerms: true,
        completedAt: new Date().toISOString()
      });
      if (editingInterests) {
        onSkip();
        return;
      }
      setConsent(granted);
      setDone(true);
    } catch {
      setSubmitError("Kunde inte spara ditt val. Kontrollera anslutningen och försök igen.");
    } finally {
      setSubmitting(false);
    }
  };

  if (done && !editingInterests) {
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
              : "Du ser ett allmänt blandat För dig. Slå på personalisering under Profil när du vill."}
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
        className={`onboarding-card onboarding-card--step-${step}${editingInterests ? " onboarding-card--interests" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={editingInterests ? "Redigera mina intressen" : `Onboarding, steg ${step} av 2`}
      >
        <div className="onboarding-progress">
          {editingInterests ? (
            <strong className="onboarding-edit-title">Mina intressen</strong>
          ) : (
            <>
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
                  {[1, 2].map((index) => (
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
              <span className="onboarding-step">Steg {step} av 2</span>
            </>
          )}
          {editingInterests && (
            <button
              type="button"
              className="onboarding-back"
              aria-label="Stäng"
              onClick={onSkip}
            >
              <X size={16} />
            </button>
          )}
        </div>

        <div className="onboarding-body">
          {(editingInterests || step === 1) && (
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

          {!editingInterests && step === 2 && (
            <div className="onboarding-pane">
              <span className="onboarding-icon">
                <ShieldCheck size={22} />
              </span>
              <h2>Ditt flöde, ditt val</h2>
              <p className="onboarding-lede">
                {recommendationsConnected
                  ? "Om du slår på personalisering sparar Pleni partierna och politikerna du väljer och använder dem för att ordna För dig. Valen kan avslöja politiska åsikter. Tittarhistorik används inte i den här versionen."
                  : "Dina val sparas bara på den här enheten."}{" "}
                Utan personalisering ser du ett allmänt blandat <strong>För dig</strong>. Senaste
                finns kvar som ett separat val.
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
                  disabled={submitting}
                  onClick={() => void finish({ personal: true, analytics: false, email: false })}
                >
                  {submitting ? "Sparar…" : "Slå på personalisering"}
                </button>
                <button
                  type="button"
                  className="onboarding-primary onboarding-primary--ghost"
                  disabled={submitting}
                  onClick={() => void finish({ personal: false, analytics: false, email: false })}
                >
                  Fortsätt utan
                </button>
              </div>

              {submitError && (
                <p className="onboarding-submit-error" role="alert">
                  {submitError}
                </p>
              )}

              <p className="onboarding-fineprint">
                Du kan stänga av personalisering när som helst under Profil. Då blir För dig
                allmänt blandat och sparade rekommendationsval tas bort från Plenis server. Där kan du
                också exportera, återställa eller radera rekommendationsdata. Tidigare visade
                rekommendationslistor sparas i högst 30 dagar för att undvika upprepningar.
              </p>
            </div>
          )}

          {editingInterests ? (
            <>
              <div className="onboarding-actions">
                <button
                  type="button"
                  className="onboarding-primary"
                  disabled={submitting}
                  onClick={() => void finish(consent)}
                >
                  {submitting ? "Sparar…" : "Spara intressen"}
                </button>
              </div>
              {submitError && (
                <p className="onboarding-submit-error" role="alert">
                  {submitError}
                </p>
              )}
              <button type="button" className="onboarding-skip" onClick={onSkip}>
                Avbryt
              </button>
            </>
          ) : step < 2 && (
            <div className="onboarding-actions">
              <button
                type="button"
                className="onboarding-primary"
                onClick={() => setStep((s) => Math.min(2, s + 1))}
              >
                Nästa steg <ArrowRight size={16} />
              </button>
            </div>
          )}

          {!editingInterests && step < 2 && (
            <button type="button" className="onboarding-skip" onClick={onSkip}>
              Hoppa över — fortsätt till För dig
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
