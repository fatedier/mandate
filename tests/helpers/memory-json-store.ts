import type { JsonStore } from "../../src/server/platform/storage/json-store.js";

export class MemoryJsonStore<T> implements JsonStore<T> {
  constructor(private value: T) {}

  read(): T {
    return cloneJson(this.value);
  }

  write(value: T): void {
    this.value = cloneJson(value);
  }

  snapshot(): T {
    return this.read();
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
