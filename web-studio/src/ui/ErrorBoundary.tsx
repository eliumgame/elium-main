import * as React from "react";
import { clearCrashLog, formatCrashLog, reportError } from "./crash-log";

interface State {
  error: Error | null;
  copied: boolean;
}

/**
 * Dernier filet de sécurité : un plantage de rendu n'affiche plus un écran
 * blanc. Les autosauvegardes (drafts, classeurs, présentations) sont dans
 * IndexedDB et ne sont PAS touchées — recharger les récupère.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportError(
      "react-render",
      Object.assign(new Error(error.message), { stack: error.stack + "\n" + info.componentStack }),
    );
  }

  private copy = async () => {
    try {
      await navigator.clipboard.writeText(formatCrashLog());
      this.setState({ copied: true });
    } catch {
      /* presse-papiers indisponible */
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        style={{ maxWidth: 560, margin: "12vh auto", padding: 24, fontFamily: "Inter, system-ui, sans-serif" }}
      >
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>Elium a rencontré un problème</h1>
        <p style={{ marginBottom: 16, lineHeight: 1.5 }}>
          Vos documents ne sont pas perdus : les sauvegardes automatiques sont conservées sur cet appareil et seront
          proposées à la réouverture.
        </p>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.75, marginBottom: 16 }}>
          {this.state.error.message}
        </pre>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => window.location.reload()}>Recharger Elium</button>
          <button onClick={this.copy}>{this.state.copied ? "Journal copié ✓" : "Copier le journal d'incidents"}</button>
          <button
            onClick={() => {
              clearCrashLog();
              window.location.reload();
            }}
          >
            Effacer le journal et recharger
          </button>
        </div>
      </div>
    );
  }
}
