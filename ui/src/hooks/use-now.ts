import { useEffect, useState } from "react";

/** Re-renders every `ms` while `active`; returns the current time. */
export const useNow = (active = true, ms = 1000) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
};
