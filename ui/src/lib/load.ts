import { useEffect, useState } from "react";
import { Unauthorized } from "./api";

export const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Fetch once per key (null: nothing to fetch); a new key drops what the old one brought. */
export function useLoad<T>(key: string | null, fetcher: () => Promise<T>) {
  const [state, setState] = useState<{ key: string | null; data?: T; error?: string }>({ key: null });
  useEffect(() => {
    if (!key) return;
    let live = true;
    setState({ key });
    fetcher()
      .then((data) => live && setState({ key, data }))
      .catch((error) => live && !(error instanceof Unauthorized) && setState({ key, error: errText(error) }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { key };
}
