export function currentTrace():
  | undefined
  | { add: (stage: string, message: string, data?: unknown) => void } {
  return undefined;
}
