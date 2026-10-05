import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AgentModels } from "@/lib/types";

let modelsCache: Promise<AgentModels> | null = null;
const loadModels = () => {
  modelsCache ??= api<AgentModels>("GET", "/api/models").catch((error) => {
    modelsCache = null;
    throw error;
  });
  return modelsCache;
};

/** The models and efforts each agent kind offers, fetched once for the page. */
export function useModels() {
  const [models, setModels] = useState<AgentModels | null>(null);
  useEffect(() => {
    let alive = true;
    loadModels()
      .then((m) => alive && setModels(m))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return models;
}
