import { BellIcon, RefreshCwIcon, SmartphoneIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api, ApiError, Unauthorized } from "@/lib/api";
import { ago } from "@/lib/format";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Hint } from "@/components/common/states";
import { fail, Shell } from "./Dialogs";

interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeen: string;
  push: boolean;
}

interface PairLink {
  url: string;
  base: string;
  kind: "https" | "lan";
  qr: string;
}

interface Pairing {
  code: string;
  expiresAt: string;
  links: PairLink[];
  /** When it was made: a device paired after this used it. */
  madeAt: string;
}

const KIND_LABEL: Record<PairLink["kind"], string> = { https: "Tailscale · HTTPS", lan: "Wi‑Fi" };

/** A device's name; the daemon leaves it empty when the browser was not recognised. */
const nameOf = (device: { name: string }) => device.name || "Невідомий браузер";

/** "був щойно", "був 5 хв тому", "був 3 жовт." */
const lastSeen = (iso: string) => {
  const when = ago(iso);
  return `був ${when}${/(хв|год)$/.test(when) ? " тому" : ""}`;
};

const left = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const useNow = (every: number) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
};

// --- on the computer: a code for the phone, and the paired devices -------------------------------------------------

function PairPanel() {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [linkIndex, setLinkIndex] = useState(0);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const now = useNow(1000);

  const makeCode = useCallback(async () => {
    try {
      const made = await api<Omit<Pairing, "madeAt">>("POST", "/api/pair", {});
      setPairing({ ...made, madeAt: new Date().toISOString() });
      setUnreachable(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setUnreachable(error.message);
      else fail(error);
    }
  }, []);

  const loadDevices = useCallback(async () => {
    try {
      setDevices((await api<{ devices: Device[] }>("GET", "/api/devices")).devices);
    } catch (error) {
      if (!(error instanceof Unauthorized)) setDevices((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void makeCode();
    void loadDevices();
    // A phone that pairs while this is open shows up here.
    const timer = setInterval(() => void loadDevices(), 3000);
    return () => clearInterval(timer);
  }, [makeCode, loadDevices]);

  // Explicit, from this computer only: the daemon starts (or stops) listening on the Wi‑Fi now, and keeps the choice.
  const expose = async (lan: boolean) => {
    try {
      await api("POST", "/api/exposure", lan ? { lan: true } : { lan: false, hosts: [] });
      if (lan) await makeCode();
      else {
        setPairing(null);
        setUnreachable("closed");
      }
    } catch (error) {
      fail(error);
    }
  };

  const revoke = async (device: Device) => {
    try {
      await api("DELETE", `/api/devices/${encodeURIComponent(device.id)}`);
      toast.success(`${nameOf(device)}: доступ відкликано`);
      void loadDevices();
    } catch (error) {
      fail(error);
    }
  };

  const joined = pairing ? devices?.find((device) => device.createdAt >= pairing.madeAt) : undefined;
  const expired = pairing ? new Date(pairing.expiresAt).getTime() <= now : false;
  const link = pairing?.links[Math.min(linkIndex, pairing.links.length - 1)];
  const port = location.port || "7717";

  return (
    <>
      {unreachable ? (
        <div className="flex flex-col gap-2 text-ui leading-relaxed">
          <p>Зараз Agoryx відкривається лише на цьому комп'ютері.</p>
          <Button size="sm" className="w-fit" onClick={() => void expose(true)}>
            Відкрити для телефона в цій Wi‑Fi
          </Button>
          <Hint>
            Демон почне слухати адресу комп'ютера у Wi‑Fi одразу, без перезапуску, і запам'ятає це. Те саме в терміналі: <code className="font-mono">agoryx up --lan</code>.
            Через Tailscale (HTTPS, зі сповіщеннями): <code className="font-mono">agoryx up --tailscale</code>, потім <code className="font-mono">tailscale serve --bg {port}</code>.
          </Hint>
        </div>
      ) : !pairing || !link ? (
        <div className="grid h-[252px] place-items-center text-small text-muted-foreground">Готуємо код…</div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-center">
          {pairing.links.length > 1 ? (
            <div className="flex gap-1 rounded-xl bg-muted p-1">
              {pairing.links.map((entry, i) => (
                <button
                  key={entry.url}
                  type="button"
                  onClick={() => setLinkIndex(i)}
                  className={cn("rounded-lg px-2.5 py-1 text-small font-medium", link === entry ? "bg-card shadow-soft" : "text-muted-foreground")}
                >
                  {KIND_LABEL[entry.kind]}
                </button>
              ))}
            </div>
          ) : null}
          <div className={cn("relative rounded-2xl bg-white p-2 shadow-soft ring-1 ring-border", (expired || joined) && "opacity-15")}>
            <img src={link.qr} alt="QR-код для телефона" className="size-[208px]" draggable={false} />
          </div>
          {joined ? (
            <p className="text-ui">
              Під'єднано: <b>{nameOf(joined)}</b>
            </p>
          ) : expired ? (
            <p className="text-ui text-muted-foreground">Код прострочено.</p>
          ) : (
            <>
              <p className="text-ui leading-relaxed">Наведіть камеру телефона на код.</p>
              <Hint className="text-center">
                Або відкрийте <span className="font-mono text-foreground">{link.base}</span> і введіть
                <span className="mt-1 block font-mono text-title font-semibold tracking-[0.18em] text-foreground">{pairing.code}</span>
                Код одноразовий, ще {left(pairing.expiresAt, now)}.
              </Hint>
            </>
          )}
          {expired || joined ? (
            <Button variant="outline" size="sm" className="gap-2" onClick={() => void makeCode()}>
              <RefreshCwIcon className="size-3.5" />
              Новий код
            </Button>
          ) : null}
          {link.kind === "lan" && !joined ? <Hint className="text-center">Сповіщення на телефон — лише через HTTPS (Tailscale).</Hint> : null}
          <button type="button" onClick={() => void expose(false)} className="text-small text-muted-foreground underline-offset-2 hover:underline">
            Закрити доступ з інших пристроїв
          </button>
        </div>
      )}
      <div className="flex flex-col gap-1.5 border-t border-border pt-3.5">
        <div className="text-meta font-medium tracking-wider text-faint uppercase">Під'єднані пристрої</div>
        {devices === null ? null : devices.length === 0 ? (
          <Hint>Ще жодного.</Hint>
        ) : (
          devices.map((device) => (
            <div key={device.id} className="flex items-center gap-3 rounded-xl px-1 py-1.5">
              <SmartphoneIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="flex items-center gap-1.5 truncate text-ui font-medium">
                  {nameOf(device)}
                  {device.push ? <BellIcon className="size-3.5 text-muted-foreground" aria-label="Сповіщення увімкнено" /> : null}
                </span>
                <span className="truncate text-meta text-muted-foreground">
                  <span className="font-mono">{device.id}</span> · {lastSeen(device.lastSeen)}
                </span>
              </div>
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void revoke(device)}>
                Відкликати
              </Button>
            </div>
          ))
        )}
      </div>
    </>
  );
}

// --- on the phone: this device, and its notifications -----------------------------------------------------------------

const keyBytes = (base64url: string) => {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const iOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function DevicePanel({ device }: { device: { id: string; name: string } }) {
  const [state, setState] = useState<{ publicKey: string | null; subscribed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    api<{ publicKey: string | null; subscribed: boolean }>("GET", "/api/push")
      .then((data) => live.current && setState(data))
      .catch(fail);
    return () => {
      live.current = false;
    };
  }, []);

  const toggle = async (on: boolean) => {
    if (!state?.publicKey) return;
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      if (on) {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          toast.error("Сповіщення заборонено в налаштуваннях браузера");
          return;
        }
        const existing = await registration.pushManager.getSubscription();
        const subscription =
          existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.publicKey) }));
        await api("POST", "/api/push", { subscription: subscription.toJSON() });
      } else {
        await (await registration.pushManager.getSubscription())?.unsubscribe();
        await api("POST", "/api/push", { subscription: null });
      }
      if (live.current) setState({ ...state, subscribed: on });
    } catch (error) {
      fail(error);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const test = async () => {
    try {
      const sent = await api<{ sent: number; failed: number }>("POST", "/api/push/test", {});
      if (sent.sent > 0) toast.success("Надіслано");
      else toast.error("Не вдалося надіслати — увімкніть сповіщення ще раз");
    } catch (error) {
      fail(error);
    }
  };

  let push;
  if (!window.isSecureContext) {
    push = <Hint>Сповіщення працюють лише через HTTPS: відкрийте Agoryx через Tailscale serve.</Hint>;
  } else if (!pushSupported()) {
    push = (
      <Hint>{iOS() ? "На iPhone: «Поділитися» → «На початковий екран», і відкрийте Agoryx звідти." : "Цей браузер не приймає сповіщень."}</Hint>
    );
  } else if (!state) {
    push = null;
  } else {
    push = (
      <>
        <label className="flex items-center justify-between gap-3 text-sm">
          Сповіщення, коли кімната чекає на вас
          <Switch checked={state.subscribed} disabled={busy} onCheckedChange={(on) => void toggle(on)} />
        </label>
        {state.subscribed ? (
          <Button variant="outline" size="sm" className="w-fit" onClick={() => void test()}>
            Перевірити
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-muted">
          <SmartphoneIcon className="size-5 text-primary" />
        </span>
        <div className="flex flex-col leading-tight">
          <span className="text-body font-semibold">{nameOf(device)}</span>
          <span className="font-mono text-meta text-muted-foreground">{device.id}</span>
        </div>
      </div>
      <Hint>Цей пристрій під'єднано до Agoryx на комп'ютері. Відкликати доступ можна там: «Відкрити на телефоні» чи agoryx devices.</Hint>
      <div className="flex flex-col gap-2.5 border-t border-border pt-3.5">{push}</div>
    </>
  );
}

export function PhoneDialog() {
  const device = useStore((s) => s.device);
  return (
    <Shell title={device ? "Цей пристрій" : "Відкрити на телефоні"} size="sm">
      {device ? <DevicePanel device={device} /> : <PairPanel />}
    </Shell>
  );
}
