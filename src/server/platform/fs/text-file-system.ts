import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface TextFileSystem {
  exists(filePath: string): boolean;
  readText(filePath: string): string;
  writeText(filePath: string, contents: string): void;
  mkdirp(dirPath: string): void;
  atomicWriteText(filePath: string, contents: string, tmpPrefix?: string): void;
  removeFile(filePath: string): void;
}

export const nodeTextFileSystem: TextFileSystem = {
  exists(filePath) {
    return fs.existsSync(filePath);
  },

  readText(filePath) {
    return fs.readFileSync(filePath, "utf8");
  },

  writeText(filePath, contents) {
    fs.writeFileSync(filePath, contents, "utf8");
  },

  mkdirp(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
  },

  atomicWriteText(filePath, contents, tmpPrefix = ".tmp") {
    const tmp = path.join(path.dirname(filePath), `${tmpPrefix}-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, contents, "utf8");
      fs.renameSync(tmp, filePath);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
      throw error;
    }
  },

  removeFile(filePath) {
    fs.unlinkSync(filePath);
  }
};
