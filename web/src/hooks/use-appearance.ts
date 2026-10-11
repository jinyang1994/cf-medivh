import { useEffect, useSyncExternalStore } from 'react';

let hidden: boolean | undefined;
let revision = 0;
let pending: Promise<void> | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function applySavedAppearance(hideSocialIcons: boolean) {
  revision++;
  hidden = hideSocialIcons;
  listeners.forEach((listener) => listener());
}
async function loadAppearance() {
  const started = revision;
  try {
    const response = await fetch('/api/settings/appearance', {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (typeof data.hideSocialIcons !== 'boolean') throw new Error();
    if (started === revision) applySavedAppearance(data.hideSocialIcons);
  } catch {
    if (started === revision) applySavedAppearance(false);
  }
}
export function useHideSocialIcons() {
  const value = useSyncExternalStore(subscribe, () => hidden);
  useEffect(() => {
    pending ??= loadAppearance();
  }, []);
  // Avoid flashing a hidden icon while loading the saved preference.
  return value !== false;
}
