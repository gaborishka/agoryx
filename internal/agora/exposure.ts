import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { agoraHome } from "./paths.js";

/**
 * Where the daemon can be reached from besides this computer: the LAN (`agoryx up --lan`) and the HTTPS
 * proxy names it answers to (`--tailscale`, `--allow-host`). The human's choice is kept in
 * `<agoraHome>/exposure.json`, so a daemon started again — by `agoryx up`, the app, or after a crash —
 * is reachable the same way; `agoryx up --local` forgets it. Nothing is ever exposed by default.
 */
export interface Exposure {
  lan: boolean;
  hosts: string[];
}

export const LOCAL_ONLY: Exposure = { lan: false, hosts: [] };

export const exposureFile = (env: NodeJS.ProcessEnv = process.env): string => join(agoraHome(env), "exposure.json");

export const normalizeHosts = (hosts: readonly string[]): string[] => [
  ...new Set(hosts.map((host) => host.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean)),
];

export const isExposed = (exposure: Exposure): boolean => exposure.lan || exposure.hosts.length > 0;

/** The saved exposure, or local only (no file, or one that does not parse). */
export const readExposure = (env: NodeJS.ProcessEnv = process.env): Exposure => {
  try {
    const fields = JSON.parse(readFileSync(exposureFile(env), "utf8")) as { version?: unknown; lan?: unknown; hosts?: unknown };
    if (fields.version !== 1) return LOCAL_ONLY;
    const hosts = Array.isArray(fields.hosts) ? fields.hosts.filter((host): host is string => typeof host === "string") : [];
    return { lan: fields.lan === true, hosts: normalizeHosts(hosts) };
  } catch {
    return LOCAL_ONLY;
  }
};

/** Keeps the human's choice; local only removes the file. */
export const writeExposure = (exposure: Exposure, env: NodeJS.ProcessEnv = process.env): void => {
  const path = exposureFile(env);
  if (!isExposed(exposure)) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, lan: exposure.lan, hosts: normalizeHosts(exposure.hosts) }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};

/**
 * Interfaces a phone on the same Wi-Fi or cable reaches: Wi-Fi and Ethernet by their names (macOS en*,
 * Linux eth*, en*, wl*, Windows "Wi-Fi"/"Ethernet"). VPN tunnels (utun, tun, ppp, ipsec, wg), VM and
 * container bridges (bridge, vmnet, docker, veth, vboxnet) and Tailscale are not the LAN.
 */
export const isLanInterface = (name: string, platform: NodeJS.Platform = process.platform): boolean => {
  if (platform === "darwin") return /^en\d+$/.test(name);
  if (platform === "win32") return /^(wi-?fi|wlan|ethernet)\b/i.test(name);
  return /^(eth|en|wl)/.test(name);
};

const isPrivateIpv4 = (address: string): boolean => {
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
};

/** This computer's private IPv4 addresses on its Wi-Fi and Ethernet interfaces — where `--lan` listens. */
export const lanInterfaces = (
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
  platform: NodeJS.Platform = process.platform,
): Array<{ address: string; iface: string }> => {
  const found = new Map<string, string>();
  for (const [iface, list] of Object.entries(interfaces)) {
    if (!isLanInterface(iface, platform)) continue;
    for (const entry of list ?? []) {
      if (entry.family !== "IPv4" || entry.internal || !isPrivateIpv4(entry.address)) continue;
      if (!found.has(entry.address)) found.set(entry.address, iface);
    }
  }
  return [...found].map(([address, iface]) => ({ address, iface }));
};

export const lanAddresses = (): string[] => lanInterfaces().map((entry) => entry.address);
