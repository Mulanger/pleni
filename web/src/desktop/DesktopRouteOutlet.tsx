import type { ReactNode } from "react";
import type { AppRoute } from "../navigation";
import { DesktopPage, DesktopRouteFrame, DesktopSection, DesktopState } from "./primitives";
import { describeDesktopRoute } from "./route-outlet";
import type { DesktopRouteId } from "./route-outlet";

export function DesktopRouteOutlet({
  route,
  surfaces,
  onHome,
  onBack
}: {
  route: AppRoute;
  surfaces: Partial<Record<DesktopRouteId, ReactNode>>;
  onHome: () => void;
  onBack: () => void;
}) {
  const descriptor = describeDesktopRoute(route);
  const surface = surfaces[descriptor.id];

  return (
    <DesktopRouteFrame focusKey={descriptor.focusKey}>
      {descriptor.available && surface ? (
        surface
      ) : (
        <DesktopPage
          eyebrow={descriptor.eyebrow}
          title={descriptor.title}
          description={descriptor.description}
          backLabel={descriptor.backAction === "history" ? "Tillbaka" : "Till videoflödet"}
          onBack={descriptor.backAction === "history" ? onBack : onHome}
        >
          <DesktopSection>
            <DesktopState
              kind="empty"
              title="Desktopvyn är under arbete"
              detail="Inget innehåll eller någon kontodata har ersatts. Öppna sidan på en mobilskärm för den nuvarande funktionen."
            />
          </DesktopSection>
        </DesktopPage>
      )}
    </DesktopRouteFrame>
  );
}
