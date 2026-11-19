/**
 * The model-call worker's first import: a stray rejection or throw is logged
 * and the worker goes on, as on the main thread (logger.ts). Left alone, one
 * would end the worker and fail every stream it holds, on every thread.
 * First, so it holds from the start of the worker's evaluation.
 */
import { logError } from "../../platform/logger.js";

process.on("unhandledRejection", (reason) => { logError("model worker", reason, "unhandled promise rejection"); });
process.on("uncaughtException", (error) => { logError("model worker", error, "uncaught exception"); });
