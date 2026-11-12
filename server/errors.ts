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
  if (error instanceof DOMException && error.name === "AbortError") {
    return { status: 499, message: "工作已取消或逾時。" };
  }
  return { status: 500, message: "伺服器處理時發生錯誤，請稍後再試。" };
}
