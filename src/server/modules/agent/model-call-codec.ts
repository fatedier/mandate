import type { ModelMessage } from "ai";

/**
 * What a model call sends to another thread and gets back, kept as it is.
 * Structured clone drops an error's class and the properties it does not
 * know, and refuses a URL or a function; the retry policy, the summary check
 * and Activity's record read errors by their names and own properties
 * (nested causes, the request body, the stream's facts), and the AI SDK
 * tells a URL from its string. So errors are copied property by property,
 * with each property's enumerability, and a URL is tagged and revived.
 */

const ERROR_TAG = "__mandateError";
const URL_TAG = "__mandateUrl";
const CIRCULAR = "[Circular]";

interface EncodedProperty { key: string; enumerable: boolean; value: unknown }
export interface EncodedError {
  [ERROR_TAG]: true;
  constructorName: string;
  properties: EncodedProperty[];
  /** The name when it is inherited (a class's prototype), not the error's own. */
  inheritedName?: string;
}

export function encodeError(error: unknown): unknown {
  return encodeValue(error, new WeakSet());
}

export function decodeError(encoded: unknown): unknown {
  return decodeValue(encoded);
}

function isErrorLike(value: object): boolean {
  return value instanceof Error || (typeof DOMException !== "undefined" && value instanceof DOMException);
}

function encodeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" || typeof value === "symbol" ? undefined : value;
  }
  if (seen.has(value)) return CIRCULAR;
  if (value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (value instanceof URL) return { [URL_TAG]: value.href };
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => encodeValue(item, seen));
    if (isErrorLike(value)) {
      const properties: EncodedProperty[] = [];
      for (const key of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) continue;
        // A getter of the error's own (zod's message) is copied as what it reads.
        let read: unknown;
        if ("value" in descriptor) read = descriptor.value;
        else if (descriptor.get) {
          try { read = descriptor.get.call(value); } catch { continue; }
        } else continue;
        if (typeof read === "function") continue;
        properties.push({ key, enumerable: descriptor.enumerable ?? false, value: encodeValue(read, seen) });
      }
      const own = (key: string) => Object.prototype.hasOwnProperty.call(value, key);
      const encoded: EncodedError = {
        [ERROR_TAG]: true,
        constructorName: value.constructor?.name || "Error",
        properties
      };
      // A class may keep its name on its prototype; DOMException keeps
      // name, message and code there as getters. What they read is copied
      // as the error's own, unenumerated, as reading them gave.
      if (!own("name") && typeof (value as Error).name === "string") encoded.inheritedName = (value as Error).name;
      const taken = new Set(properties.map((p) => p.key));
      for (let proto = Object.getPrototypeOf(value); proto && proto !== Error.prototype && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const key of Object.getOwnPropertyNames(proto)) {
          if (key === "name" || key === "constructor" || taken.has(key)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(proto, key);
          if (!descriptor?.get) continue;
          const read = (value as Record<string, unknown>)[key];
          if (read === null || ["string", "number", "boolean"].includes(typeof read)) {
            properties.push({ key, enumerable: false, value: read });
            taken.add(key);
          }
        }
      }
      return encoded;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const encoded = encodeValue(child, seen);
      if (encoded !== undefined || child === undefined) out[key] = encoded;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function errorClassNamed(name: string): new () => Error {
  // A class of the same name, so a reader that names an error by its
  // constructor reads the same; still an Error.
  return ({ [name]: class extends Error {} } as Record<string, new () => Error>)[name]!;
}

function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  const record = value as Record<string, unknown>;
  if (typeof record[URL_TAG] === "string" && Object.keys(record).length === 1) return new URL(record[URL_TAG] as string);
  if (record[ERROR_TAG] === true) {
    const encoded = record as unknown as EncodedError;
    if (encoded.constructorName === "DOMException" && typeof DOMException !== "undefined") return decodeDomException(encoded);
    const ErrorClass = encoded.constructorName === "Error" ? Error : errorClassNamed(encoded.constructorName);
    const error = new ErrorClass();
    // The new error's own stack and message give way to the original's.
    for (const key of Object.getOwnPropertyNames(error)) delete (error as unknown as Record<string, unknown>)[key];
    if (encoded.inheritedName !== undefined) {
      Object.defineProperty(error, "name", { value: encoded.inheritedName, enumerable: false, writable: true, configurable: true });
    }
    for (const property of encoded.properties) {
      Object.defineProperty(error, property.key, { value: decodeValue(property.value), enumerable: property.enumerable, writable: true, configurable: true });
    }
    return error;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) out[key] = decodeValue(child);
  return out;
}

/** A DOMException is made again as one (its name, message and code are
 *  the class's own getters, and readers tell one by its constants). */
function decodeDomException(encoded: EncodedError): DOMException {
  const read = (key: string) => encoded.properties.find((p) => p.key === key)?.value;
  const message = typeof read("message") === "string" ? read("message") as string : "";
  const error = new DOMException(message, encoded.inheritedName ?? (typeof read("name") === "string" ? read("name") as string : "Error"));
  for (const property of encoded.properties) {
    if (property.key === "message" || property.key === "name" || property.key === "code") continue;
    Object.defineProperty(error, property.key, { value: decodeValue(property.value), enumerable: property.enumerable, writable: true, configurable: true });
  }
  return error;
}

/** A prompt for another thread: its URL parts tagged, the rest as it is
 *  (buffers are copied by the clone, explicit nulls kept). */
export function encodePrompt(messages: ModelMessage[]): unknown {
  return encodeValue(messages, new WeakSet());
}

export function decodePrompt(value: unknown): ModelMessage[] {
  return decodeValue(value) as ModelMessage[];
}

/** Any other value for another thread (call options, a stream's result):
 *  the same tagging, errors and URLs kept. */
export function encodeData(value: unknown): unknown {
  return encodeValue(value, new WeakSet());
}

export function decodeData<T>(value: unknown): T {
  return decodeValue(value) as T;
}
