import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ScreenshotArtifact {
  runId: string;
  suiteId: string;
  nodeId: string;
  containerId: string;
  contentType: "image/png";
  data: Uint8Array;
}

export interface ScreenshotArtifactStore {
  /** Persist the PNG and return the stable id exposed on NodeResult. */
  saveScreenshot(artifact: ScreenshotArtifact): Promise<string>;
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function safeSegment(value: string): string {
  const readable = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "artifact";
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${readable}-${suffix}`;
}

function assertPng(data: Uint8Array): void {
  if (
    data.byteLength <= PNG_SIGNATURE.byteLength ||
    PNG_SIGNATURE.some((byte, index) => data[index] !== byte)
  ) {
    throw new Error("Screenshot artifact is empty or is not a PNG file");
  }
}

/** Simple filesystem store suitable for the CLI and local development. */
export class LocalArtifactStore implements ScreenshotArtifactStore {
  readonly rootDirectory: string;

  constructor(rootDirectory = ".branchpoint-artifacts") {
    if (!rootDirectory || rootDirectory.includes("\0")) {
      throw new Error("artifact root directory must be non-empty and contain no NUL");
    }
    this.rootDirectory = path.resolve(rootDirectory);
  }

  async saveScreenshot(artifact: ScreenshotArtifact): Promise<string> {
    assertPng(artifact.data);
    const runSegment = safeSegment(artifact.runId);
    const nodeSegment = safeSegment(artifact.nodeId);
    const contentHash = createHash("sha256").update(artifact.data).digest("hex").slice(0, 20);
    const id = path.posix.join(runSegment, `${nodeSegment}-${contentHash}.png`);
    const destination = this.resolveScreenshot(id);
    const directory = path.dirname(destination);
    const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);

    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, artifact.data, { flag: "wx" });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    return id;
  }

  resolveScreenshot(id: string): string {
    if (!id || id.includes("\0") || path.posix.isAbsolute(id)) {
      throw new Error("screenshot id must be a non-empty relative path");
    }
    const normalized = path.posix.normalize(id);
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new Error("screenshot id must not escape the artifact root");
    }
    const destination = path.resolve(this.rootDirectory, ...normalized.split("/"));
    if (destination === this.rootDirectory || !destination.startsWith(`${this.rootDirectory}${path.sep}`)) {
      throw new Error("screenshot id must resolve below the artifact root");
    }
    return destination;
  }
}
