import * as React from "react";
import * as ReactDOM from "react-dom/client";
import App from "./App";
import { DialogsProvider } from "./ui/dialogs";
import { applyTheme, getTheme } from "./ui/theme";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { installGlobalCrashHandlers } from "./ui/crash-log";
import { installA11yEnhancers } from "./ui/a11y-enhancers";
import { loadUserFonts } from "./ui/font-library";
import "./index.css";
import "./App.css";
import "./ui/workspace.css";

applyTheme(getTheme());
installGlobalCrashHandlers();
installA11yEnhancers();
void loadUserFonts(); // polices personnelles conservées → registre → sélecteurs

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <DialogsProvider>
        <App />
      </DialogsProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);

// Offline support: register the service worker in production builds only (it
// would interfere with Vite's dev HMR). Elium is local-first, so once the shell
// is cached it runs fully offline. Best-effort — failures are non-fatal.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline support is best-effort */
    });
  });
}
