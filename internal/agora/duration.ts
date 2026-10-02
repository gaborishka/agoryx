/**
 * A turn's time limit in words, as it was set to the second (rounded down, as the turn clock in the UI rounds it):
 * "45s", "1:30", "20 min", "1 h 30 min", "1:30:15".
 */
export const limitText = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s % 60) return s < 3600 ? `${Math.floor(s / 60)}:${pad(s % 60)}` : `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  const m = s / 60;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
};
