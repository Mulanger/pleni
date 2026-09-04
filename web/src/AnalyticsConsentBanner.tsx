import { BarChart3, ChevronDown, ChevronUp, X } from "lucide-react";
import { useState } from "react";
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
  const [detailsOpen, setDetailsOpen] = useState(settingsOpen);
  return (
    <section
      className="analytics-consent"
      role="dialog"
      aria-modal="false"
      aria-labelledby="analytics-consent-title"
    >
      <div className="analytics-consent-heading">
        <span className="analytics-consent-icon" aria-hidden="true">
          <BarChart3 size={18} />
        </span>
        <div>
          <h2 id="analytics-consent-title">
            {settingsOpen ? "Analysinställningar" : "Hjälp oss förstå vad som fungerar"}
          </h2>
          <p>
            Med ditt val mäter vi sammanställd besöksstatistik och hur offentliga klipp används
            med Google Analytics. Pleni fungerar lika bra om du tackar nej.
          </p>
        </div>
        {settingsOpen && (
          <button type="button" className="analytics-consent-close" onClick={onClose} aria-label="Stäng analysinställningar">
            <X size={18} />
          </button>
        )}
      </div>

      <button
        type="button"
        className="analytics-consent-details-toggle"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen((open) => !open)}
      >
        Vad mäts?
        {detailsOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {detailsOpen && (
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
          <button type="button" className="analytics-consent-info-link" onClick={onOpenCookieInfo}>
            Läs om cookies och lagring
          </button>
        </div>
      )}

      <div className="analytics-consent-actions">
        <button type="button" onClick={() => onChoose("denied")}>Endast nödvändiga</button>
        <button type="button" onClick={() => onChoose("granted")}>Acceptera analys</button>
      </div>
    </section>
  );
}
