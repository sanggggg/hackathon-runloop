import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Run, Suite } from "@branchpoint/schema";
import { StoreConflictError, StoreNotFoundError } from "./errors.js";

interface DatabaseFile {
  version: 1;
  suites: Suite[];
  runs: Run[];
}

function emptyDatabase(): DatabaseFile {
  return { version: 1, suites: [], runs: [] };
}

function parseDatabase(contents: string, filename: string): DatabaseFile {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Cannot parse Branchpoint database '${filename}'`, { cause: error });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { suites?: unknown }).suites) ||
    !Array.isArray((value as { runs?: unknown }).runs)
  ) {
    throw new Error(`Branchpoint database '${filename}' has an unsupported shape or version`);
  }
  return value as DatabaseFile;
}

export interface BranchpointStore {
  initialize(): Promise<void>;
  listSuites(): Promise<Suite[]>;
  getSuite(id: string): Promise<Suite | undefined>;
  insertSuite(suite: Suite): Promise<Suite>;
  replaceSuite(suite: Suite): Promise<Suite>;
  listRuns(suiteId?: string): Promise<Run[]>;
  getRun(id: string): Promise<Run | undefined>;
  insertRun(run: Run): Promise<Run>;
  replaceRun(run: Run): Promise<Run>;
  recoverInterruptedRuns(now: string): Promise<Run[]>;
}

/**
 * Single-process JSON store for the Railway Volume deployment. Writes are
 * serialized and committed through atomic rename; use a DB-backed adapter
 * before enabling multiple server replicas.
 */
export class JsonFileStore implements BranchpointStore {
  readonly filename: string;
  #database = emptyDatabase();
  #initialized = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(filename: string) {
    if (!filename || filename.includes("\0")) throw new Error("database path is invalid");
    this.filename = path.resolve(filename);
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(path.dirname(this.filename), { recursive: true });
    try {
      this.#database = parseDatabase(await readFile(this.filename, "utf8"), this.filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#database = emptyDatabase();
      await this.#persist();
    }
    this.#initialized = true;
  }

  async listSuites(): Promise<Suite[]> {
    return this.#read(() =>
      [...this.#database.suites].sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  async getSuite(id: string): Promise<Suite | undefined> {
    return this.#read(() => this.#database.suites.find((suite) => suite.id === id));
  }

  async insertSuite(suite: Suite): Promise<Suite> {
    return this.#mutate(() => {
      if (this.#database.suites.some((entry) => entry.id === suite.id)) {
        throw new StoreConflictError(`suite '${suite.id}' already exists`);
      }
      this.#database.suites.push(structuredClone(suite));
      return suite;
    });
  }

  async replaceSuite(suite: Suite): Promise<Suite> {
    return this.#mutate(() => {
      const index = this.#database.suites.findIndex((entry) => entry.id === suite.id);
      if (index < 0) throw new StoreNotFoundError(`suite '${suite.id}' does not exist`);
      this.#database.suites[index] = structuredClone(suite);
      return suite;
    });
  }

  async listRuns(suiteId?: string): Promise<Run[]> {
    return this.#read(() =>
      this.#database.runs
        .filter((run) => !suiteId || run.suiteId === suiteId)
        .sort((left, right) => {
          const leftTime = left.createdAt ?? left.startedAt;
          const rightTime = right.createdAt ?? right.startedAt;
          return rightTime.localeCompare(leftTime);
        }),
    );
  }

  async getRun(id: string): Promise<Run | undefined> {
    return this.#read(() => this.#database.runs.find((run) => run.id === id));
  }

  async insertRun(run: Run): Promise<Run> {
    return this.#mutate(() => {
      if (this.#database.runs.some((entry) => entry.id === run.id)) {
        throw new StoreConflictError(`run '${run.id}' already exists`);
      }
      this.#database.runs.push(structuredClone(run));
      return run;
    });
  }

  async replaceRun(run: Run): Promise<Run> {
    return this.#mutate(() => {
      const index = this.#database.runs.findIndex((entry) => entry.id === run.id);
      if (index < 0) throw new StoreNotFoundError(`run '${run.id}' does not exist`);
      this.#database.runs[index] = structuredClone(run);
      return run;
    });
  }

  async recoverInterruptedRuns(now: string): Promise<Run[]> {
    return this.#mutate(() => {
      const recovered: Run[] = [];
      this.#database.runs = this.#database.runs.map((run) => {
        if (
          run.executionStatus !== "queued" &&
          run.executionStatus !== "running" &&
          run.executionStatus !== "cancelling"
        ) {
          return run;
        }
        const value: Run = {
          ...run,
          executionStatus: "failed",
          finishedAt: now,
          error: {
            code: "server_restarted",
            message: "The server restarted before this run finished; start a new run.",
          },
        };
        recovered.push(value);
        return value;
      });
      return recovered;
    });
  }

  async #read<T>(operation: () => T): Promise<T> {
    this.#assertInitialized();
    await this.#tail;
    return structuredClone(operation());
  }

  async #mutate<T>(operation: () => T): Promise<T> {
    this.#assertInitialized();
    let result!: T;
    const task = this.#tail.then(async () => {
      const before = structuredClone(this.#database);
      try {
        result = operation();
        await this.#persist();
      } catch (error) {
        this.#database = before;
        throw error;
      }
    });
    this.#tail = task.catch(() => undefined);
    await task;
    return structuredClone(result);
  }

  async #persist(): Promise<void> {
    const directory = path.dirname(this.filename);
    const temporary = path.join(directory, `.${path.basename(this.filename)}.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(this.#database, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.filename);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("Branchpoint store has not been initialized");
  }
}
