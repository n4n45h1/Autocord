import { Buffer } from "node:buffer";

type OpenCodeMessage = {
  id: string;
  type: string;
  agent?: string;
  finish?: string;
  time?: { completed?: number };
  tokens?: { input?: number; output?: number };
  error?: { type?: string; message?: string; status?: number };
  content?: { type: string; text?: string }[];
};

type OpenCodePlanResult = { object: unknown; model: string; inputTokens: number; outputTokens: number };

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (password) {
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }
  return headers;
}

async function jsonRequest<T>(baseUrl: string, path: string, init: RequestInit, signal: AbortSignal): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), { ...init, headers: { ...authHeaders(), ...init.headers }, signal });
  const body = await response.json().catch(() => null) as { data?: T; message?: string; error?: { message?: string } } | null;
  if (!response.ok) {
    const message = body?.message ?? body?.error?.message;
    throw Object.assign(new Error(message ?? `OpenCode server returned HTTP ${response.status}`), { status: response.status });
  }
  return (body && "data" in body ? body.data : body) as T;
}

function parsePlanText(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate || candidate.startsWith("{") === false) throw new Error("OpenCodeモデルがJSON形式の操作計画を返しませんでした。");
  return JSON.parse(candidate);
}

export async function generateOpenCodePlan(prompt: string, model: string, timeoutMs: number): Promise<OpenCodePlanResult> {
  const baseUrl = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4197";
  const [providerID, ...modelParts] = model.split("/");
  const modelID = modelParts.join("/");
  if (!providerID || !modelID) throw new Error("OpenCodeモデルはprovider/model形式で指定してください。");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let sessionId: string | undefined;
  try {
    const session = await jsonRequest<{ id: string }>(baseUrl, "/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: "Autocord role-panel plan",
        agent: "plan",
        model: { providerID, id: modelID },
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      }),
    }, controller.signal);
    sessionId = session.id;
    await jsonRequest(baseUrl, `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: prompt }),
    }, controller.signal);

    while (!controller.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const messages = await jsonRequest<OpenCodeMessage[]>(baseUrl, `/api/session/${encodeURIComponent(sessionId)}/message?type=assistant&order=desc&limit=5`, { method: "GET" }, controller.signal);
      const message = messages[0];
      if (!message?.time?.completed) continue;
      if (message.error || message.finish === "error" || message.finish === "tool-calls") {
        const detail = message.error?.message ?? `OpenCode agent finished with ${message.finish ?? "an error"}`;
        throw Object.assign(new Error(detail), { status: message.error?.status });
      }
      const text = message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") ?? "";
      return {
        object: parsePlanText(text),
        model: `${providerID}/${modelID}`,
        inputTokens: message.tokens?.input ?? 0,
        outputTokens: message.tokens?.output ?? 0,
      };
    }
    throw new Error("OpenCodeモデル呼び出しがタイムアウトしました。");
  } finally {
    clearTimeout(timeout);
    if (sessionId) {
      await fetch(new URL(`/api/session/${encodeURIComponent(sessionId)}`, baseUrl), {
        method: "DELETE",
        headers: authHeaders(),
      }).catch(() => undefined);
    }
  }
}

export function extractPlanJson(text: string): unknown {
  return parsePlanText(text);
}
