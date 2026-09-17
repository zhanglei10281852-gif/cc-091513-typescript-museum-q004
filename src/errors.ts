/** 业务错误：携带 HTTP 状态码、稳定错误码与中文说明。 */
export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
}
