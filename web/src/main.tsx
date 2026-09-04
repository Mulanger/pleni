import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { parseClipBootstrap } from "./clip-entry";
import { AuthProvider } from "./clerk";
import { initialRoute } from "./navigation";
import { registerPwa } from "./pwa/register";
import "./styles.css";

const route = initialRoute(window.location);
const bootstrapNode = document.getElementById("pleni-clip-bootstrap");
const initialClip = route.view === "clip"
  ? parseClipBootstrap(bootstrapNode?.textContent, route.clipId)
  : null;
bootstrapNode?.remove();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <App initialClip={initialClip} />
    </AuthProvider>
  </StrictMode>
);

registerPwa();
