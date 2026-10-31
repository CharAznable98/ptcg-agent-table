import type {
  Viewer,
  MatchView,
  CommandReceipt,
  GameCommand,
  PlayerId,
} from "../../../packages/protocol/src/index.ts";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, { ...options, headers });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      data.error?.code ?? "HTTP_ERROR",
      data.error?.message ?? `请求失败 (${response.status})`,
    );
  return data as T;
}
export const jsonBody = (value: unknown) => JSON.stringify(value);
export function allowedViewers(
  match: Pick<MatchView, "mode" | "players">,
  finished: boolean,
): Viewer[] {
  if (finished || match.mode === "ai_ai") return ["A", "B", "omniscient"];
  return match.players
    .filter((player) => player.kind === "human")
    .map((player) => player.id);
}
export function submitCommand(
  id: string,
  revision: number,
  command: GameCommand,
  playerId: PlayerId,
) {
  return api<CommandReceipt>(`/matches/${id}/commands`, {
    method: "POST",
    body: jsonBody({
      playerId,
      requestId: crypto.randomUUID(),
      revision,
      command,
    }),
  });
}
export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
export async function importFile(file: File): Promise<unknown> {
  return JSON.parse(await file.text());
}

/** 使用 fetch 流同步事件；断线由调用者重取观察并重连。 */
export async function streamMatch(
  id: string,
  viewer: Viewer | null,
  cursor: string,
  onChange: () => void,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({ after: cursor });
  if (viewer) query.set("viewer", viewer);
  const response = await fetch(`/api/matches/${id}/events?${query}`, {
    signal,
  });
  if (!response.ok || !response.body)
    throw new Error("实时连接中断，正在重新同步");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (frame.split("\n").some((line) => line.startsWith("data:")))
        onChange();
    }
  }
}
export function matchPath(
  id: string,
  viewer: Viewer | null,
  replay: number | null,
) {
  const query = new URLSearchParams();
  if (viewer) query.set("viewer", viewer);
  if (replay !== null) query.set("index", String(replay));
  const suffix = query.size ? `?${query}` : "";
  return `/matches/${id}${replay === null ? "" : "/replay"}${suffix}`;
}
export type { MatchView };
