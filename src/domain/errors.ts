/** 领域错误：携带稳定错误码，HTTP 层据此映射状态码。 */
export class DomainError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.statusCode = statusCode;
  }

  static notFound(what: string): DomainError {
    return new DomainError("not_found", `${what}不存在`, 404);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
