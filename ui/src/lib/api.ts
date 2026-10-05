export class Unauthorized extends Error {}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (response.status === 401) {
    onUnauthorized();
    throw new Unauthorized(String(data.error ?? "unauthorized"));
  }
  if (!response.ok) throw new ApiError(String(data.error ?? `HTTP ${response.status}`), response.status, data);
  return data as T;
}

export const roomPath = (roomId: string, suffix = "") => `/api/rooms/${encodeURIComponent(roomId)}${suffix}`;

export const local = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`agoryx.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value == null) localStorage.removeItem(`agoryx.${key}`);
      else localStorage.setItem(`agoryx.${key}`, value);
    } catch {
      // private mode
    }
  },
};
