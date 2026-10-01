import { useId } from "react";
import { Avatar } from "@/components/room/bits";
import type { RoomAgent } from "@/lib/types";
import { MARK_DOT, MARK_LEFT, MARK_RIGHT } from "./Mark";

/*
 * The start screen's square: the mark at the centre, the rows of an agora around it, and the room
 * seated on the outer row — Claudes on the clay side, Codexes on the water side, as in the mark, and
 * the human at the front, between them, as the mark's dot. The outer row runs from clay to water.
 * It gathers once when the screen opens (legs meet, the human's dot lands, the rows draw, the seats fill);
 * with reduced motion it simply stands there.
 */
const W = 360;
const H = 262;
const C = { x: W / 2, y: 122 };
const ROWS = [70, 92, 112];
const MARK = 4.5;

/** Angles (degrees, 0 = right) for `n` seats on one side, fanned around the horizontal. */
const fan = (n: number, side: "left" | "right") => {
  const spread = Math.min(26 * (n - 1), 70);
  return Array.from({ length: n }, (_, i) => {
    const offset = n === 1 ? 0 : -spread / 2 + (spread * i) / (n - 1);
    return side === "left" ? 180 + offset : -offset;
  });
};

export function Agora({ agents, label }: { agents: RoomAgent[]; label: string }) {
  const id = useId();
  const clip = `${id}-clip`;
  const row = `${id}-row`;
  const claudes = agents.filter((agent) => agent.kind === "claude");
  const codexes = agents.filter((agent) => agent.kind !== "claude");
  // One kind only: half on each side, so the square stays balanced.
  const [left, right] =
    claudes.length && codexes.length
      ? [claudes, codexes]
      : [agents.slice(0, Math.ceil(agents.length / 2)), agents.slice(Math.ceil(agents.length / 2))];
  const seats = [
    ...left.map((agent, i) => ({ agent, angle: fan(left.length, "left")[i] })),
    ...right.map((agent, i) => ({ agent, angle: fan(right.length, "right")[i] })),
  ];
  const r = ROWS.at(-1)!;

  return (
    <figure className="agora relative mx-auto w-full max-w-[360px]" style={{ aspectRatio: `${W} / ${H}` }} aria-label={label}>
      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full overflow-visible" aria-hidden>
        <defs>
          <clipPath id={clip}>
            <path d={MARK_LEFT} />
          </clipPath>
          <linearGradient id={row} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="var(--claude-0)" />
            <stop offset="0.5" stopColor="var(--meet)" />
            <stop offset="1" stopColor="var(--codex-0)" />
          </linearGradient>
        </defs>
        {ROWS.map((radius, i) => {
          const outer = i === ROWS.length - 1;
          return (
            <circle
              key={radius}
              className="agora-row"
              style={{ animationDelay: `${120 + i * 90}ms` }}
              cx={C.x}
              cy={C.y}
              r={radius}
              fill="none"
              stroke={outer ? `url(#${row})` : "color-mix(in oklab, var(--foreground) 16%, transparent)"}
              strokeOpacity={outer ? 0.6 : 1}
              strokeWidth={outer ? 1.75 : 1}
              strokeDasharray={outer ? undefined : "2 5"}
            />
          );
        })}
        <g transform={`translate(${C.x - 12 * MARK} ${C.y - 12.6 * MARK}) scale(${MARK})`}>
          <path className="agora-leg agora-leg-l" d={MARK_LEFT} fill="var(--claude-0)" />
          <path className="agora-leg agora-leg-r" d={MARK_RIGHT} fill="var(--codex-0)" />
          <path className="agora-meet" d={MARK_RIGHT} fill="var(--meet)" clipPath={`url(#${clip})`} />
          <circle className="agora-dot" {...MARK_DOT} fill="var(--human)" />
        </g>
      </svg>
      {/* The human: at the front of the square, the laurel dot of the mark. */}
      <span
        className="agora-seat absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
        style={{ left: "50%", top: `${((C.y + r) / H) * 100}%`, animationDelay: "460ms" }}
      >
        <span className="grid size-[38px] place-items-center rounded-[30%] bg-human-soft shadow-soft ring-2 ring-background">
          <span className="size-3.5 rounded-full bg-human" />
        </span>
        <span className="absolute top-full mt-1 rounded-md bg-background px-1.5 text-meta font-medium whitespace-nowrap text-human-ink">You</span>
      </span>
      {seats.map(({ agent, angle }, i) => {
        const x = C.x + r * Math.cos((angle * Math.PI) / 180);
        const y = C.y - r * Math.sin((angle * Math.PI) / 180);
        return (
          <span
            key={agent.id}
            className="agora-seat absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
            style={{ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%`, animationDelay: `${520 + i * 70}ms` }}
          >
            <Avatar handle={agent.id} roster={agents} size={38} className="shadow-soft ring-2 ring-background" />
            <span className="absolute top-full mt-1 rounded-md bg-background px-1.5 text-meta font-medium whitespace-nowrap text-muted-foreground">
              {agent.label}
            </span>
          </span>
        );
      })}
    </figure>
  );
}
