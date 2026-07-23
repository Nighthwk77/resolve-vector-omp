const DEFAULT_USAGE_URL = "http://127.0.0.1:11436/usage";

export interface UsageWindow {
  type?: string;
  window?: string;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  used_percent?: number | null;
  remaining_percent?: number | null;
  resets_at?: string | null;
}

export interface GlmUsage {
  ok: boolean;
  cached?: boolean;
  stale?: boolean;
  error?: string;
  five_hour?: UsageWindow | null;
  windows?: UsageWindow[];
}

export async function fetchGlmUsage(
  fetcher: typeof fetch = fetch,
  url = process.env.RV_ZAI_USAGE_URL ?? DEFAULT_USAGE_URL,
): Promise<GlmUsage> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(5000) });
    const body = await response.json() as GlmUsage;
    if (!response.ok || !body.ok) {
      return { ok: false, error: body.error ?? `usage endpoint returned HTTP ${response.status}` };
    }
    return body;
  } catch (error) {
    return { ok: false, error: `${error instanceof Error ? error.message : error}` };
  }
}

export function compactGlmUsage(usage: GlmUsage): string {
  const fiveHour = usage.five_hour;
  if (!usage.ok || !fiveHour) return "GLM usage unavailable";
  if (typeof fiveHour.remaining_percent === "number") {
    return `GLM 5h: ${Math.round(fiveHour.remaining_percent)}% left`;
  }
  if (typeof fiveHour.remaining === "number" && typeof fiveHour.limit === "number") {
    return `GLM 5h: ${fiveHour.remaining}/${fiveHour.limit} left`;
  }
  return "GLM 5h: usage available";
}

export function detailedGlmUsage(usage: GlmUsage): string {
  if (!usage.ok) return `GLM usage unavailable${usage.error ? ` — ${usage.error}` : ""}`;
  const lines = [compactGlmUsage(usage)];
  for (const window of usage.windows ?? []) {
    if (window === usage.five_hour) continue;
    const label = window.window ?? window.type ?? "quota";
    if (typeof window.remaining === "number" && typeof window.limit === "number") {
      lines.push(`${label}: ${window.remaining}/${window.limit} left`);
    } else if (typeof window.remaining_percent === "number") {
      lines.push(`${label}: ${Math.round(window.remaining_percent)}% left`);
    }
    if (window.resets_at) lines.push(`${label} resets: ${window.resets_at}`);
  }
  if (usage.stale) lines.push("cached usage (live refresh failed)");
  return lines.join("\n");
}
