import { useState, type CSSProperties } from "react";

import { PARTIES, partyInk, partyTint } from "./data";
import { normalizePartyLogoUrl } from "./party-logo-policy";
import type { PartyCode } from "./types";

export function PartyLogo({
  party,
  logoUrl,
  color,
  className = ""
}: {
  party: PartyCode;
  logoUrl?: string | null;
  color?: string;
  className?: string;
}) {
  const profile = PARTIES[party];
  const partyColor = color ?? profile.color;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const displayUrl = normalizePartyLogoUrl(logoUrl);
  const showImage = displayUrl !== null && failedUrl !== displayUrl;
  const imageReady = showImage && loadedUrl === displayUrl;

  return (
    <span
      className={`party-logo ${className}`.trim()}
      style={
        {
          "--party-logo-color": partyColor,
          background: partyTint(partyColor),
          color: partyInk(partyColor)
        } as CSSProperties
      }
      aria-hidden="true"
    >
      {!imageReady && <span className="party-logo-fallback">{profile.abbr}</span>}
      {showImage && (
        <img
          className={imageReady ? "party-logo-image is-ready" : "party-logo-image"}
          src={displayUrl}
          alt=""
          loading="eager"
          decoding="async"
          onLoad={() => setLoadedUrl(displayUrl)}
          onError={() => setFailedUrl(displayUrl)}
        />
      )}
    </span>
  );
}
