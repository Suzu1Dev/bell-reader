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
): Promise<T> {
  const res = await fetch(path, {
    method,
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
