import type { ReactNode } from "react";
import type { AppRoute } from "../navigation";
import { DesktopPage, DesktopRouteFrame, DesktopSection, DesktopState } from "./primitives";
import { describeDesktopRoute } from "./route-outlet";

export function DesktopRouteOutlet({
  route,
  home,
  onHome,
  onBack
}: {
  route: AppRoute;
  home: ReactNode;
  onHome: () => void;
  onBack: () => void;
}) {
  const descriptor = describeDesktopRoute(route);

  return (
    <DesktopRouteFrame focusKey={descriptor.focusKey}>
      {descriptor.available ? (
        home
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
