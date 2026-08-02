/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  /**
   * Set to "true" to let the built-in demo clips stand in when the catalogue is
   * empty or Supabase is unconfigured. Off by default and must stay off in any
   * telemetry-bearing build (prerequisite FE-1).
   */
  readonly VITE_ALLOW_SAMPLE_CLIPS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
