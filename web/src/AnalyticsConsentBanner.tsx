import { X } from "lucide-react";
import type { AnalyticsConsentChoice } from "./analytics-consent";

export function AnalyticsConsentBanner({
  currentChoice,
  settingsOpen,
  onChoose,
  onClose,
  onOpenCookieInfo
}: {
  currentChoice: AnalyticsConsentChoice | null;
  settingsOpen: boolean;
  onChoose: (choice: AnalyticsConsentChoice) => void;
  onClose: () => void;
  onOpenCookieInfo: () => void;
}) {
  return (
    <section
      className="analytics-consent"
      role="dialog"
      aria-modal="false"
      aria-labelledby="analytics-consent-title"
      aria-describedby="analytics-consent-description"
    >
      <div className="analytics-consent-heading">
        <h2 id="analytics-consent-title">
          {settingsOpen ? "Cookie-inställningar" : "Cookies och analys"}
        </h2>
        {settingsOpen && (
          <button type="button" className="analytics-consent-close" onClick={onClose} aria-label="Stäng analysinställningar">
            <X size={18} />
          </button>
        )}
      </div>

      <p id="analytics-consent-description" className="analytics-consent-summary">
        Vi använder nödvändig lagring för att Pleni ska fungera. Med ditt godkännande
        använder vi Google Analytics för att förstå besök och videouppspelning. Läs vår{" "}
        <button type="button" className="analytics-consent-info-link" onClick={onOpenCookieInfo}>
          cookiepolicy
        </button>
        .
      </p>

      {settingsOpen && (
        <div className="analytics-consent-details">
          <p>
            Vi mäter sidbesök, kvalificerade klippvisningar och uppspelningstid. Vi
            skickar aldrig namn, e-post, Clerk-id, söktext, följningar, gillningar,
            sparningar, kommentarer eller en politisk intresseprofil till Google.
          </p>
          {currentChoice && (
            <p className="analytics-consent-current" role="status">
              Nuvarande val: {currentChoice === "granted" ? "analys tillåten" : "endast nödvändiga"}.
            </p>
          )}
        </div>
      )}

      <div className="analytics-consent-actions">
        <button type="button" onClick={() => onChoose("denied")}>Endast nödvändiga cookies</button>
        <button type="button" onClick={() => onChoose("granted")}>Tillåt analyscookies</button>
      </div>
    </section>
  );
}
