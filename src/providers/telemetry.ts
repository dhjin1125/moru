import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
export type ModelTelemetryContext = {
  conversationId: string;
  operationId: string;
  role: string;
  tickCursor: number;
  retainMessages: boolean;
  previousMessages: number;
};
const contexts = new AsyncLocalStorage<ModelTelemetryContext>();
export const modelTelemetryContext = () => contexts.getStore();
export function withModelTelemetry<T>(
  context: ModelTelemetryContext,
  run: () => T,
): T {
  return contexts.run(context, run);
}
export function modelTelemetry(dir: string) {
  let writing = Promise.resolve();
  return (event: Record<string, unknown>) => {
    writing = writing
      .then(() =>
        appendFile(
          join(dir, "telemetry.jsonl"),
          JSON.stringify({ at: Date.now(), ...event }) + "\n",
        ),
      )
      .catch(() => {});
    return writing;
  };
}
