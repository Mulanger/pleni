import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { PARTIES, partyInk, partyTint } from "./data";
import {
  forgetPartyLogoSuccess,
  hasPartyLogoSuccess,
  isCompletePartyLogoImage,
  normalizePartyLogoUrl,
  rememberPartyLogoSuccess,
  shouldShowPartyLogoFallback
} from "./party-logo-policy";
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
  const displayUrl = normalizePartyLogoUrl(logoUrl);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(() =>
    displayUrl !== null && hasPartyLogoSuccess(displayUrl) ? displayUrl : null
  );
  const imageRef = useRef<HTMLImageElement | null>(null);
  const showImage = displayUrl !== null && failedUrl !== displayUrl;
  const imageReady = showImage && loadedUrl === displayUrl;
  const showFallback = shouldShowPartyLogoFallback(displayUrl, failedUrl);

  const markLoaded = useCallback((image: HTMLImageElement) => {
    if (
      displayUrl === null ||
      image !== imageRef.current ||
      !isCompletePartyLogoImage(image)
    ) {
      return;
    }
    rememberPartyLogoSuccess(displayUrl);
    setLoadedUrl((current) => (current === displayUrl ? current : displayUrl));
  }, [displayUrl]);

  const markFailed = useCallback((image: HTMLImageElement) => {
    if (displayUrl === null || image !== imageRef.current) {
      return;
    }
    forgetPartyLogoSuccess(displayUrl);
    setLoadedUrl((current) => (current === displayUrl ? null : current));
    setFailedUrl(displayUrl);
  }, [displayUrl]);

  useLayoutEffect(() => {
    if (imageRef.current !== null) {
      markLoaded(imageRef.current);
    }
  }, [markLoaded]);

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
      {showFallback && <span className="party-logo-fallback">{profile.abbr}</span>}
      {showImage && (
        <img
          ref={imageRef}
          className={imageReady ? "party-logo-image is-ready" : "party-logo-image"}
          src={displayUrl}
          alt=""
          loading="eager"
          decoding="async"
          onLoad={(event) => markLoaded(event.currentTarget)}
          onError={(event) => markFailed(event.currentTarget)}
        />
      )}
    </span>
  );
}
