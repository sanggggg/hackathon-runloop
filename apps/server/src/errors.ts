export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: readonly string[];

  constructor(status: number, code: string, message: string, details?: readonly string[]) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export class StoreNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreNotFoundError";
  }
}
