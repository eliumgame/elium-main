import { useSyncExternalStore } from "react";
import { getFontsVersion, subscribeFonts } from "./fonts";

/** Re-rend le composant quand une police est ajoutée ou retirée (sélecteurs de police). */
export function useFontsVersion(): number {
  return useSyncExternalStore(subscribeFonts, getFontsVersion, getFontsVersion);
}
