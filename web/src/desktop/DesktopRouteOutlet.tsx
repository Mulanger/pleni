import type { ReactNode } from "react";
import type { AppRoute } from "../navigation";
import { DesktopPage, DesktopRouteFrame, DesktopSection, DesktopState } from "./primitives";
import { describeDesktopRoute } from "./route-outlet";
import type { DesktopRouteId } from "./route-outlet";

export function DesktopRouteOutlet({
  route,
  surfaces,
  surfaceFocusKey,
  onEscape
}: {
  route: AppRoute;
  surfaces: Partial<Record<DesktopRouteId, ReactNode>>;
  surfaceFocusKey?: string | null;
  onEscape: () => void;
}) {
  const descriptor = describeDesktopRoute(route);
  const surface = surfaces[descriptor.id];

  return (
    <DesktopRouteFrame
      focusKey={`${descriptor.focusKey}:${surfaceFocusKey ?? "route"}`}
      onEscape={onEscape}
    >
      {surface ? (
        surface
      ) : (
        <DesktopPage
          eyebrow={descriptor.eyebrow}
          title="Sidan kunde inte visas"
          description="Pleni kunde inte montera den här vyn. Ladda om sidan och försök igen."
        >
          <DesktopSection>
            <DesktopState
              kind="error"
              title="Ett oväntat visningsfel inträffade"
              detail="Ingen kontodata eller mediefil har ändrats."
            />
          </DesktopSection>
        </DesktopPage>
      )}
    </DesktopRouteFrame>
  );
}
