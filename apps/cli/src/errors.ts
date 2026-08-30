export const EXIT_CODE = {
  ok: 0,
  regression: 1,
  stale: 2,
  usage: 3,
  remote: 3,
  timeout: 124,
  sigint: 130,
  sigterm: 143,
} as const;

export type CliExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: CliExitCode;

  constructor(message: string, code: string, exitCode: CliExitCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  constructor(message: string, code = "invalid_usage", options?: ErrorOptions) {
    super(message, code, EXIT_CODE.usage, options);
    this.name = "UsageError";
  }
}

export class RemoteError extends CliError {
  constructor(message: string, code = "remote_error", options?: ErrorOptions) {
    super(message, code, EXIT_CODE.remote, options);
    this.name = "RemoteError";
  }
}

export class ApiError extends RemoteError {
  readonly status: number;
  readonly requestId?: string;
  readonly details?: readonly string[];

  constructor(
    status: number,
    code: string,
    message: string,
    options: { requestId?: string; details?: readonly string[] } = {},
  ) {
    super(message, code);
    this.name = "ApiError";
    this.status = status;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

export class WaitTimeoutError extends CliError {
  constructor(message: string) {
    super(message, "wait_timeout", EXIT_CODE.timeout);
    this.name = "WaitTimeoutError";
  }
}

export class SignalInterruption extends CliError {
  readonly signal: NodeJS.Signals;

  constructor(signal: "SIGINT" | "SIGTERM") {
    super(
      `received ${signal}`,
      signal === "SIGINT" ? "sigint" : "sigterm",
      signal === "SIGINT" ? EXIT_CODE.sigint : EXIT_CODE.sigterm,
    );
    this.name = "SignalInterruption";
    this.signal = signal;
  }
}
