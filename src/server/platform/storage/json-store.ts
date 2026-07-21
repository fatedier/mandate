import fs from "node:fs";
import path from "node:path";

let tmpCounter = 0;

export type JsonRecord = Record<string, unknown>;

export interface JsonStore<T> {
  readonly filePath?: string;
  read(): T;
  write(value: T): void;
}

export interface JsonFileStoreOptions<T> {
  filePath: string;
  defaultValue: () => T;
  validate?: (value: unknown) => value is T;
  invalidMessage?: string;
  mode?: number;
}

export class JsonFileStore<T> implements JsonStore<T> {
  readonly filePath: string;

  constructor(private readonly options: JsonFileStoreOptions<T>) {
    this.filePath = options.filePath;
  }

  read(): T {
    if (!fs.existsSync(this.filePath)) {
      return this.options.defaultValue();
    }
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (this.options.validate && !this.options.validate(parsed)) {
      throw new Error(this.options.invalidMessage ?? `${this.filePath} must contain valid JSON`);
    }
    return parsed as T;
  }

  write(value: T): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    tmpCounter += 1;
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.${tmpCounter}.tmp`;
    const options = this.options.mode === undefined
      ? { encoding: "utf8" as const }
      : { encoding: "utf8" as const, mode: this.options.mode };
    fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, options);
    fs.renameSync(tmpPath, this.filePath);
    if (this.options.mode !== undefined) {
      fs.chmodSync(this.filePath, this.options.mode);
    }
  }
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
