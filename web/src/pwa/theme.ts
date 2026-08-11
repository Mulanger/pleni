export const APP_THEME_COLOR = {
  dark: "#050608",
  light: "#fafaf9"
} as const;

export type AppSurfaceTheme = keyof typeof APP_THEME_COLOR;

export function applyBrowserTheme(surface: AppSurfaceTheme): void {
  const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeMeta?.setAttribute("content", APP_THEME_COLOR[surface]);
}
