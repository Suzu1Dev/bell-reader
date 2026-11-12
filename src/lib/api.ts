export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : `請求失敗（${res.status}）`);
  }
  return body as T;
}

export async function apiWrite<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  payload: unknown = {},
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(path, {
    method,
    signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : `操作失敗（${res.status}）`);
  }
  return body as T;
}

export async function apiAnnotateStream<T>(
  pageId: string,
  onStage: (message: string) => void,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}/annotate`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      accept: "application/x-ndjson",
    },
    body: "{}",
  });

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body?.error === "string" ? body.error : `批註失敗（${res.status}）`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: T | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        const event = JSON.parse(line) as { type: string; message?: string } & T;
        if (event.type === "stage" && event.message) {
          onStage(event.message);
        } else if (event.type === "error") {
          throw new Error(event.message || "AI 批註失敗，請稍後再試。");
        } else if (event.type === "complete") {
          finalResult = event;
        }
      }
      nl = buffer.indexOf("\n");
    }
  }

  if (!finalResult) {
    throw new Error("AI 批註未回傳完整結果，請重試。");
  }
  return finalResult;
}
