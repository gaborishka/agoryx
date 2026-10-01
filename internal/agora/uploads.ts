/**
 * Files the human attaches to a message: a picked file or a pasted screenshot. The browser has no path for
 * either, so the bytes are kept under the agora home, each in its own folder under its own name, and the
 * message links them by absolute path — the agents open them with their own tools, the UI shows the media.
 * Nothing is written into the room's workspace.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { agoraHome } from "./paths.js";

export const MAX_UPLOAD = 20 * 1024 * 1024;

export const uploadsDir = (env: NodeJS.ProcessEnv = process.env): string => join(agoraHome(env), "uploads");

/** A file name safe on any disk and in a markdown link: no folders, no control or markdown-breaking characters. */
export const uploadName = (name: string): string => {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*()[\]#%`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!clean) return "file";
  if (clean.length <= 120) return clean;
  const ext = extname(clean).slice(0, 16);
  return `${clean.slice(0, 120 - ext.length)}${ext}`;
};

export class UploadError extends Error {}

/** Keeps the bytes and returns where: `<home>/uploads/<random>/<name>`. */
export const saveUpload = (name: string, bytes: Buffer, env: NodeJS.ProcessEnv = process.env): string => {
  if (!bytes.length) throw new UploadError("the file is empty");
  if (bytes.length > MAX_UPLOAD) throw new UploadError(`the file is larger than ${MAX_UPLOAD / 1024 / 1024} MB`);
  const dir = join(uploadsDir(env), `${new Date().toISOString().slice(0, 10)}-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, uploadName(name));
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
};
