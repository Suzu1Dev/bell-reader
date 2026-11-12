export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function publicError(error: unknown): { status: number; message: string } {
  if (error instanceof AppError) {
    return { status: error.status, message: error.message };
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { status: 504, message: "AI 批註等待時間過長，請重試或在設定切換模型供應商。" };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { status: 499, message: "已取消此次批註。" };
  }
  return { status: 500, message: "伺服器處理時發生錯誤，請稍後再試。" };
}
