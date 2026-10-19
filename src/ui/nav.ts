import { useEffect, useRef, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'session'; id: number }
  | { name: 'collection' }
  | { name: 'data' }
  | { name: 'settings' }
  | { name: 'about' };

// The phone's back button / gesture closes the top sheet first, then goes back a screen.
const sheets: { close: () => void }[] = [];
let ignorePops = 0;
let setRouteFromHistory: ((r: Route) => void) | null = null;

window.addEventListener('popstate', (e) => {
  if (ignorePops > 0) {
    ignorePops--;
    return;
  }
  const top = sheets.pop();
  if (top) {
    top.close();
    return;
  }
  // A sheet entry with no sheet open is left over from a reload while a sheet was up: skip past it.
  if (e.state?.sheet) {
    history.back();
    return;
  }
  setRouteFromHistory?.((e.state?.route as Route) ?? { name: 'home' });
});

// Reloaded while a sheet was open: step back off its entry so the next Back press leaves the screen.
if (history.state?.sheet) {
  ignorePops++;
  history.back();
}

export function useRoute(): [Route, (r: Route) => void, () => void] {
  const [route, setRoute] = useState<Route>(() => (history.state?.route as Route) ?? { name: 'home' });
  useEffect(() => {
    if (!history.state?.route) history.replaceState({ route }, '');
    setRouteFromHistory = setRoute;
    return () => {
      setRouteFromHistory = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const go = (r: Route) => {
    history.pushState({ route: r }, '');
    setRoute(r);
  };
  const back = () => history.back();
  return [route, go, back];
}

/** While mounted, the back button calls onClose instead of leaving the screen. */
export function useBackToClose(onClose: () => void) {
  const ref = useRef(onClose);
  useEffect(() => {
    ref.current = onClose;
  });
  useEffect(() => {
    const entry = { close: () => ref.current() };
    sheets.push(entry);
    history.pushState({ ...history.state, sheet: true }, '');
    return () => {
      const i = sheets.indexOf(entry);
      if (i >= 0) {
        // Closed from the UI: drop the history entry we added.
        sheets.splice(i, 1);
        ignorePops++;
        history.back();
      }
    };
  }, []);
}
