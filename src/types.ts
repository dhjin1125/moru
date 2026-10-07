export type Selection = { provider: string; model: string; thinking: string };
export type Session = {
  id: string;
  title: string;
  selection: Selection;
  createdAt: number;
  updatedAt: number;
  messages: any[];
  status: "idle" | "queued" | "running" | "error";
  error?: string;
  partial?: any;
  version?: string;
  parentId?: string;
  archivedAt?: number;
  contextCheckpoint?: {
    summary: string;
    messageCount: number;
    createdAt: number;
  };
};
export type Job = {
  id: string;
  sessionId: string;
  text: string;
  selection: Selection;
  status: "queued" | "running" | "completed" | "error";
  createdAt: number;
  error?: string;
  version?: string;
};
export type CatalogProvider = {
  id: string;
  name: string;
  connected: boolean;
  source?: string;
  error?: string;
  methods: { type: string; name: string }[];
  models: {
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
    thinkingLevels: string[];
  }[];
  custom?: boolean;
};
