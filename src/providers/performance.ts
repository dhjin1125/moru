export class RequestPerformance {
  startedAt: number;
  firstOutputAt?: number;
  outputBytes = 0;
  outputCharacters = 0;
  outputTokens: number | null = null;
  inputTokens: number | null = null;
  constructor(private readonly clock = () => performance.now()) {
    this.startedAt = clock();
  }
  output(text: string) {
    if (!text) return;
    this.firstOutputAt ??= this.clock();
    this.outputBytes += Buffer.byteLength(text);
    this.outputCharacters += [...text].length;
  }
  usage(input: number, output: number) {
    if (Number.isFinite(input) && input >= 0) this.inputTokens = input;
    if (Number.isFinite(output) && output >= 0) this.outputTokens = output;
  }
  finish() {
    const elapsedMs = Math.max(0, this.clock() - this.startedAt);
    return {
      elapsedMs,
      firstOutputMs:
        this.firstOutputAt === undefined
          ? null
          : this.firstOutputAt - this.startedAt,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      outputTokensPerSecond:
        this.outputTokens === null || elapsedMs <= 0
          ? null
          : this.outputTokens / (elapsedMs / 1000),
      outputBytes: this.outputBytes,
      outputCharacters: this.outputCharacters,
      outputCharactersPerSecond:
        elapsedMs > 0 ? this.outputCharacters / (elapsedMs / 1000) : null,
      definition:
        "Output tokens per total request second, including time to first output; only computed from provider-reported usage.",
    };
  }
}
