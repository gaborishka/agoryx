import { Avatar } from "@/components/room/bits";
import { inkColor, participant } from "@/lib/room";
import type { RoomAgent } from "@/lib/types";
import { MARK_HALF_A, MARK_HALF_B } from "./Mark";

/*
 * The start screen's square: the mark at the centre and the room seated on one ring around it,
 * Claudes on the left, Codexes on the right, the human at the front. Each seat lights its own stretch
 * of the ring in its own colour; the mark stays ink, the colour of what they will settle together.
 * It gathers once when the screen opens (the ring draws, the two halves close, the seats fill);
 * with reduced motion it simply stands there.
 */
const W = 360;
const H = 262;
const C = { x: W / 2, y: 122 };
const R = 112;
const MARK = 4.2;

/** Angles (degrees, 0 = right) for `n` seats on one side, fanned around the horizontal. */
const fan = (n: number, side: "left" | "right") => {
  const spread = Math.min(26 * (n - 1), 70);
  return Array.from({ length: n }, (_, i) => {
    const offset = n === 1 ? 0 : -spread / 2 + (spread * i) / (n - 1);
    return side === "left" ? 180 + offset : -offset;
  });
};

const point = (deg: number) => {
  const rad = (deg * Math.PI) / 180;
  return { x: C.x + R * Math.cos(rad), y: C.y - R * Math.sin(rad) };
};

/** The stretch of the ring `half` degrees either side of `deg`. */
const arc = (deg: number, half: number) => {
  const a = point(deg - half);
  const b = point(deg + half);
  return `M${a.x} ${a.y} A${R} ${R} 0 0 0 ${b.x} ${b.y}`;
};

export function Agora({ agents, label }: { agents: RoomAgent[]; label: string }) {
  const claudes = agents.filter((agent) => agent.kind === "claude");
  const codexes = agents.filter((agent) => agent.kind !== "claude");
  // One kind only: half on each side, so the square stays balanced.
  const [left, right] =
    claudes.length && codexes.length
      ? [claudes, codexes]
      : [agents.slice(0, Math.ceil(agents.length / 2)), agents.slice(Math.ceil(agents.length / 2))];
  const seats = [
    ...left.map((agent, i) => ({ agent, angle: fan(left.length, "left")[i], half: left.length === 1 ? 34 : 11 })),
    ...right.map((agent, i) => ({ agent, angle: fan(right.length, "right")[i], half: right.length === 1 ? 34 : 11 })),
  ];
  const colour = (agent: RoomAgent) => {
    const p = participant({ agents }, agent.id);
    return inkColor(p) ?? (p.tone === "sys" ? "var(--muted-foreground)" : `var(--${p.tone})`);
  };
  const front = point(270);

  return (
    <figure className="agora relative mx-auto w-full max-w-[360px]" style={{ aspectRatio: `${W} / ${H}` }} aria-label={label}>
      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full overflow-visible" aria-hidden>
        <circle className="agora-ring" cx={C.x} cy={C.y} r={R} fill="none" stroke="var(--border)" strokeWidth={1.25} />
        <g strokeWidth={2.5} strokeLinecap="round" fill="none">
          {seats.map(({ agent, angle, half }, i) => (
            <path
              key={agent.id}
              className="agora-arc"
              style={{ animationDelay: `${520 + i * 70}ms` }}
              d={arc(angle, half)}
              stroke={colour(agent)}
            />
          ))}
          <path className="agora-arc" style={{ animationDelay: "460ms" }} d={arc(270, 22)} stroke="var(--human)" />
        </g>
        <g transform={`translate(${C.x - 12 * MARK} ${C.y - 12 * MARK}) scale(${MARK})`} fill="var(--meet)">
          <path className="agora-half agora-half-a" d={MARK_HALF_A} />
          <path className="agora-half agora-half-b" d={MARK_HALF_B} />
        </g>
      </svg>
      {/* The human: at the front of the square. */}
      <span
        className="agora-seat absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
        style={{ left: "50%", top: `${(front.y / H) * 100}%`, animationDelay: "460ms" }}
      >
        <span className="grid size-[38px] place-items-center rounded-[30%] bg-human-soft shadow-soft ring-2 ring-background">
          <span className="size-3.5 rounded-full bg-human" />
        </span>
        <span className="absolute top-full mt-1 rounded-md bg-background px-1.5 text-meta font-medium whitespace-nowrap text-human-ink">You</span>
      </span>
      {seats.map(({ agent, angle }, i) => {
        const { x, y } = point(angle);
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
