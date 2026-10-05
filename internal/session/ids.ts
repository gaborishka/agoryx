import { randomUUID } from "node:crypto";

export const nowIso = (): string => new Date().toISOString();

export const createId = (prefix: string): string => `${prefix}_${randomUUID()}`;
