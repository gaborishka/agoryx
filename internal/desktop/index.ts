/**
 * The desktop core: what the macOS app (desktop/) loads from `dist/internal/desktop/index.js`, and what
 * `agoryx doctor` runs. Node built-ins and dependency-free modules only — nothing here reaches
 * better-sqlite3, ink, react or the daemon (tests/desktop/imports.test.ts checks it), so Electron's main
 * process can load it although the daemon's native modules are built for the user's node.
 */

export {
  TURN_ENV_VARS,
  desktopEnv,
  fallbackPath,
  findExecutable,
  mergeShellEnv,
  parseShellEnvOutput,
  probeLoginShell,
  type ProbeMarkers,
  type ProbeOptions,
} from "./shellenv.js";
export {
  doctorVerdict,
  formatDoctor,
  installRoot,
  runDoctor,
  type CheckStatus,
  type DoctorCheck,
  type DoctorOptions,
} from "./doctor.js";
export {
  DaemonStartError,
  DaemonSupervisor,
  type DaemonSupervisorEvents,
  type DaemonSupervisorOptions,
  type SpawnLike,
  type SupervisorFailure,
} from "./supervisor.js";
export { findDaemon, readDaemonInfo, type DaemonInfo } from "../agora/daemoninfo.js";
export { AttentionFollower, bannerFor, lookingAt, nextBannerAt, roomsWord, trayLabel, type AttentionFollowerEvents, type AttentionFollowerOptions, type Banner, type Looking, type LookingInput } from "./attention.js";
