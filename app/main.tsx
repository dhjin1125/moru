import { NodeoffBusiness } from "./NodeoffBusiness";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Code2,
  Copy,
  FileText,
  Folder,
  GitBranch,
  Loader2,
  Menu,
  Plus,
  Search,
  Settings2,
  Square,
  Terminal,
  X,
  RotateCw,
  SlidersHorizontal,
  PanelRight,
  Plug,
  CheckCircle2,
  AlertCircle,
  ArrowLeft,
  Pencil,
  WifiOff,
  Sun,
  Moon,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import type { CatalogProvider, Selection, Session } from "../src/types.ts";
import { copyText, requestId } from "./browser.ts";
import "./styles.css";

async function api(path: string, data?: any) {
  const res = await fetch(
    "/api" + path,
    data === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const value = await res.json();
  if (!res.ok) throw Error(value.error || "요청을 처리하지 못했습니다.");
  return value;
}
const date = (time: number) =>
  new Date(time).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const cls = (...parts: any[]) => parts.filter(Boolean).join(" ");
const emptySelection: Selection = { provider: "", model: "", thinking: "off" };

type CatalogModel = CatalogProvider["models"][number];
type ModelVariant = { model: CatalogModel; effort: string };
type ModelFamily = {
  key: string;
  name: string;
  /** True when several catalog entries were merged into effort variants. */
  grouped: boolean;
  variants: ModelVariant[];
};

// Some providers (e.g. Devin) publish every reasoning effort as a separate
// model id — swe-2-high, claude-opus-4-8-low-fast, gpt-5-6-sol-none-priority.
// Group those variants into one family so effort becomes a switch instead of
// a search. Only models without a real thinking parameter are grouped.
const EFFORT_TOKEN: Record<string, string> = {
  none: "off",
  nothinking: "off",
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  thinking: "on",
  reasoning: "on",
};
const EFFORT_WORD =
  /\b(no[\s-]?thinking|x[\s-]?high|thinking|reasoning|minimal|medium|low|high|max|none)\b/i;
const EFFORT_WORD_GLOBAL = new RegExp(EFFORT_WORD.source, "gi");
const EFFORT_RANK: Record<string, number> = {
  off: 0,
  on: 1,
  minimal: 2,
  low: 3,
  medium: 4,
  high: 5,
  xhigh: 6,
  max: 7,
};
const EFFORT_LABEL: Record<string, string> = {
  off: "Off",
  on: "Think",
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

function modelEffort(m: CatalogModel): string {
  const word = m.name.match(EFFORT_WORD);
  if (word)
    return EFFORT_TOKEN[word[0].toLowerCase().replace(/[\s-]/g, "")] ?? "off";
  const tokens = m.id.toLowerCase().split(/[-_]/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const e = EFFORT_TOKEN[tokens[i]];
    if (e) return e;
  }
  return "off";
}
function familyName(m: CatalogModel): string {
  const stripped = m.name
    .replace(EFFORT_WORD_GLOBAL, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return stripped || m.name;
}
function buildFamilies(models: CatalogModel[]): ModelFamily[] {
  const buckets = new Map<string, CatalogModel[]>();
  for (const m of models) {
    const groupable = (m.thinkingLevels?.length ?? 0) <= 1;
    const key = groupable ? "g:" + familyName(m).toLowerCase() : "m:" + m.id;
    const list = buckets.get(key);
    if (list) list.push(m);
    else buckets.set(key, [m]);
  }
  const families: ModelFamily[] = [];
  for (const [key, ms] of buckets) {
    const variants = ms.map((m) => ({ model: m, effort: modelEffort(m) }));
    const uniqueEfforts =
      new Set(variants.map((v) => v.effort)).size === variants.length;
    if (ms.length > 1 && uniqueEfforts) {
      variants.sort(
        (a, b) => (EFFORT_RANK[a.effort] ?? 9) - (EFFORT_RANK[b.effort] ?? 9),
      );
      families.push({ key, name: familyName(ms[0]), grouped: true, variants });
    } else {
      for (const v of variants)
        families.push({
          key: "m:" + v.model.id,
          name: v.model.name,
          grouped: false,
          variants: [v],
        });
    }
  }
  return families;
}
function defaultVariant(f: ModelFamily): ModelVariant {
  // Prefer "high" when present, otherwise the highest level not above it,
  // otherwise the lowest available level.
  let best = f.variants[0];
  for (const v of f.variants) {
    const r = EFFORT_RANK[v.effort] ?? 9;
    const b = EFFORT_RANK[best.effort] ?? 9;
    if (r <= EFFORT_RANK.high && r > b) best = v;
  }
  return best;
}
function defaultThinking(m: CatalogModel): string {
  return m.thinkingLevels?.includes("off")
    ? "off"
    : m.thinkingLevels?.[0] || "off";
}
const fmtTokens = (n: number) =>
  n >= 1_000_000
    ? (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M"
    : n >= 1000
      ? Math.round(n / 1000) + "k"
      : String(n);

type Theme = "light" | "dark";
function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem("moru.theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {}
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function Markdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(
    () =>
      DOMPurify.sanitize(
        marked.parse(text, { gfm: true, breaks: false }) as string,
      ),
    [text],
  );
  useEffect(() => {
    if (!ref.current) return;
    ref.current.querySelectorAll("a").forEach((a) => {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
    if (!streaming)
      ref.current.querySelectorAll("pre code").forEach((block) => {
        try {
          hljs.highlightElement(block as HTMLElement);
        } catch {}
      });
    ref.current
      .querySelectorAll(".code-copy")
      .forEach((button) => button.remove());
    ref.current.querySelectorAll("pre").forEach((pre) => {
      const button = document.createElement("button");
      button.className = "code-copy";
      button.textContent = "복사";
      button.setAttribute("aria-label", "코드 복사");
      button.onclick = () => {
        void copyText(pre.querySelector("code")?.textContent || "")
          .then(() => {
            button.textContent = "복사됨";
          })
          .catch(() => {
            button.textContent = "복사 실패";
          });
      };
      pre.appendChild(button);
    });
  }, [html, streaming]);
  return (
    <div
      ref={ref}
      className="markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function App() {
  const [state, setState] = useState<any>({
    sessions: [],
    catalog: [],
    jobs: [],
    runtime: { phase: "starting", processes: [] },
  });
  const [session, setSession] = useState<Session | null>(null);
  const [selection, setSelection] = useState<Selection>(() => {
    try {
      return (
        JSON.parse(localStorage.getItem("moru.selection") || "null") ||
        emptySelection
      );
    } catch {
      return emptySelection;
    }
  });
  const [draft, setDraft] = useState(
    () => sessionStorage.getItem("moru.draft") || "",
  );
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [modal, setModal] = useState<"models" | "connections" | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [query, setQuery] = useState("");
  const [activity, setActivity] = useState<any>(null);
  const [authEvent, setAuthEvent] = useState(0);
  const [filesEvent, setFilesEvent] = useState(0);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Hosts before the archive patch ignore the `archived` field, so the UI
  // mirrors archive state in localStorage. Once the host persists
  // `archivedAt`, both sources are unioned and stay consistent.
  const [archivedLocal, setArchivedLocal] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("moru.archived") || "[]");
    } catch {
      return [];
    }
  });
  const active = useRef<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const catalog: CatalogProvider[] = state.catalog;
  const provider = catalog.find((p) => p.id === selection.provider);
  const model = provider?.models.find((m) => m.id === selection.model);
  const families = useMemo(
    () => buildFamilies(provider?.models ?? []),
    [provider],
  );
  const selectedFamily = families.find(
    (f) => f.grouped && f.variants.some((v) => v.model.id === selection.model),
  );
  const running = session?.status === "running" || session?.status === "queued";
  const queued = state.jobs.filter(
    (j: any) => j.sessionId === session?.id && j.status === "queued",
  );
  const archivedSet = useMemo(() => new Set(archivedLocal), [archivedLocal]);
  const isArchived = (s: any) => !!s.archivedAt || archivedSet.has(s.id);
  const contextUsage = useMemo(() => {
    const msgs: any[] = session?.messages ?? [];
    const last =
      (session?.partial?.usage?.totalTokens ? session.partial : null) ??
      [...msgs]
        .reverse()
        .find((m) => m.role === "assistant" && m.usage?.totalTokens);
    const u = last?.usage;
    if (!u) return null;
    const used =
      (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0);
    if (!used) return null;
    const sel = last._moru?.selection ?? selection;
    const total =
      catalog
        .find((p) => p.id === sel.provider)
        ?.models.find((m) => m.id === sel.model)?.contextWindow ||
      model?.contextWindow;
    if (!total) return null;
    return { used, total, u };
  }, [session, catalog, selection, model]);
  async function openSession(id: string | null) {
    active.current = id;
    setActivity(null);
    setSideOpen(false);
    follow.current = true;
    if (!id) {
      setSession(null);
      history.replaceState(null, "", "/");
      return;
    }
    history.replaceState(null, "", "/#" + id);
    try {
      const s = await api("/sessions/" + id);
      if (active.current === id) {
        setSession(s);
        setSelection(s.selection);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    let source: EventSource | undefined;
    void api("/state")
      .then((initial) => {
        setState(initial);
        if (location.hash.slice(1)) void openSession(location.hash.slice(1));
        else if (initial.defaultSelection)
          setSelection(initial.defaultSelection);
        let openedOnce = false;
        source = new EventSource("/api/events?after=" + initial.eventId);
        source.onopen = () => {
          setConnected(true);
          // On reconnect (e.g. host restart) pull a fresh snapshot — replayed
          // events alone may not cover runtime/catalog state.
          if (openedOnce)
            void api("/state")
              .then(setState)
              .catch(() => {});
          openedOnce = true;
        };
        source.onerror = () => setConnected(false);
        const on = (type: string, fn: (data: any) => void) =>
          source!.addEventListener(type, (e) =>
            fn(JSON.parse((e as MessageEvent).data)),
          );
        on("reset", (data) => {
          setState(data);
          if (active.current)
            void api("/sessions/" + active.current).then((s) => {
              if (s.id === active.current) setSession(s);
            });
        });
        on("catalog", (data) =>
          setState((s: any) => ({ ...s, catalog: data })),
        );
        on("runtime", (runtime) => setState((s: any) => ({ ...s, runtime })));
        on("session", (data) => {
          const { messages, partial, ...summary } = data;
          setState((s: any) => ({
            ...s,
            sessions: [
              { ...summary, messageCount: messages.length },
              ...s.sessions.filter((x: any) => x.id !== data.id),
            ].sort((a, b) => b.updatedAt - a.updatedAt),
            jobs:
              data.status === "idle" || data.status === "error"
                ? s.jobs.filter(
                    (j: any) =>
                      j.sessionId !== data.id || j.status === "queued",
                  )
                : s.jobs,
          }));
          if (active.current === data.id) {
            setSession(data);
            if (data.status !== "running") setActivity(null);
          }
        });
        on("partial", (data) => {
          if (active.current === data.sessionId)
            setSession((s) =>
              s && s.id === data.sessionId
                ? { ...s, partial: data.message }
                : s,
            );
        });
        on("job", (data) =>
          setState((s: any) => ({
            ...s,
            jobs: [
              ...s.jobs.filter((j: any) => j.id !== data.id),
              ...(data.status === "queued" || data.status === "running"
                ? [data]
                : []),
            ],
          })),
        );
        on("tool", (data) => {
          if (active.current === data.sessionId)
            setActivity(data.type === "tool_execution_end" ? null : data);
        });
        on("auth", () => setAuthEvent((v) => v + 1));
        on("files", () => setFilesEvent((v) => v + 1));
        on("build", (data) => {
          if (data.error) setError("화면 빌드 오류: " + data.error);
          else location.reload();
        });
        on("notice", (data) => setError(data.error));
      })
      .catch((e) => setError(e.message));
    return () => source?.close();
  }, []);
  useEffect(() => {
    if (!selection.model && catalog.length) {
      const p = catalog.find((p) => p.connected && p.models.length);
      if (p) {
        const m = p.models.find((m) => m.id === "swe-2-high") || p.models[0];
        setSelection({ provider: p.id, model: m.id, thinking: "off" });
      }
    }
  }, [catalog, selection.model]);
  useEffect(() => {
    localStorage.setItem("moru.selection", JSON.stringify(selection));
  }, [selection]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("moru.theme", theme);
    } catch {}
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#1a1c17" : "#f9f9f6");
  }, [theme]);
  useEffect(() => {
    sessionStorage.setItem("moru.draft", draft);
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height =
        Math.min(textarea.current.scrollHeight, 200) + "px";
    }
  }, [draft]);
  useEffect(() => {
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [session?.messages, session?.partial, activity, queued.length]);
  async function selectModel(next: Selection) {
    setSelection(next);
    setModal(null);
    if (session) {
      try {
        await api("/session", { id: session.id, selection: next });
      } catch (e: any) {
        setError(e.message);
      }
    }
  }
  function toggleArchive(id: string, archived: boolean) {
    const next = archived
      ? [...new Set([...archivedLocal, id])]
      : archivedLocal.filter((x) => x !== id);
    setArchivedLocal(next);
    try {
      localStorage.setItem("moru.archived", JSON.stringify(next));
    } catch {}
    if (archived && session?.id === id) void openSession(null);
    void api("/session", { id, archived }).catch((e) => setError(e.message));
  }
  async function send() {
    if (!draft.trim() || sending) return;
    if (!provider?.connected) {
      setModal("connections");
      return;
    }
    if (!model) {
      setModal("models");
      return;
    }
    setSending(true);
    setError("");
    follow.current = true;
    try {
      let id = session?.id;
      if (!id) {
        const s = await api("/sessions", { selection });
        id = s.id;
        active.current = id!;
        setSession(s);
        history.replaceState(null, "", "/#" + id);
      }
      await api("/messages", {
        sessionId: id,
        text: draft,
        selection,
        requestId: requestId(),
      });
      setDraft("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  }
  async function stop() {
    if (session)
      try {
        await api("/stop", { sessionId: session.id });
      } catch (e: any) {
        setError(e.message);
      }
  }
  async function rename() {
    if (!session) return;
    const title = window.prompt("세션 이름", session.title);
    if (title !== null)
      try {
        await api("/session", { id: session.id, title });
      } catch (e: any) {
        setError(e.message);
      }
  }
  async function fork() {
    if (!session) return;
    try {
      const s = await api("/session", { id: session.id, action: "fork" });
      await openSession(s.id);
    } catch (e: any) {
      setError(e.message);
    }
  }
  const matchesQuery = (s: any) =>
    !query || s.title.toLowerCase().includes(query.toLowerCase());
  const sessions = state.sessions.filter(
    (s: any) => !isArchived(s) && matchesQuery(s),
  );
  const archivedSessions = state.sessions.filter(
    (s: any) => isArchived(s) && matchesQuery(s),
  );
  const activeTotal = state.sessions.filter((s: any) => !isArchived(s)).length;
  const totalConnected = catalog.filter((p) => p.connected).length;
  const sessionRow = (s: any, archived: boolean) => (
    <div
      key={s.id}
      className={cls(
        "session-link",
        s.id === session?.id && "selected",
        archived && "archived",
      )}
    >
      <button
        className="session-link-main"
        onClick={() => void openSession(s.id)}
      >
        {s.status === "running" ? (
          <span className="live-dot" />
        ) : s.parentId ? (
          <GitBranch size={14} />
        ) : (
          <span className="session-mark" />
        )}
        <span>{s.title}</span>
        {!archived && s.id === session?.id && <ChevronRight size={13} />}
      </button>
      <button
        className="session-row-action"
        aria-label={archived ? "보관 해제" : "세션 보관"}
        title={archived ? "목록으로 복원" : "보관함으로 이동"}
        onClick={() => toggleArchive(s.id, !archived)}
      >
        {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
      </button>
    </div>
  );
  return (
    <div className="app-shell">
      {sideOpen && (
        <button
          className="mobile-scrim"
          aria-label="메뉴 닫기"
          onClick={() => setSideOpen(false)}
        />
      )}
      <aside className={cls("sidebar", sideOpen && "open")}>
        <button
          className="wordmark"
          onClick={() => void openSession(null)}
          aria-label="Moru 홈"
        >
          moru
          <span className="brand-dot" />
        </button>
        <div className="sidebar-tools">
          <button
            className="new-session"
            onClick={() => void openSession(null)}
          >
            <Plus size={17} />
            <span>새 세션</span>
            <kbd>⌘ K</kbd>
          </button>
        </div>
        <div className="session-search">
          <Search size={14} />
          <input
            aria-label="세션 검색"
            placeholder="세션 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="section-label">
          YOUR WORKSPACE{" "}
          <span>{activeTotal.toString().padStart(2, "0")}</span>
        </div>
        <nav className="session-list" aria-label="세션 목록">
          {sessions.length ? (
            sessions.map((s: any) => sessionRow(s, false))
          ) : (
            <p className="sidebar-empty">
              첫 대화가
              <br />
              새로운 작업의 시작입니다.
            </p>
          )}
          {archivedSessions.length > 0 && (
            <div className="archive-section">
              <button
                className="archive-toggle"
                aria-expanded={archiveOpen}
                onClick={() => setArchiveOpen((v) => !v)}
              >
                <ChevronRight
                  size={12}
                  className={cls(archiveOpen && "open")}
                />
                보관함
                <span className="count">{archivedSessions.length}</span>
              </button>
              {archiveOpen &&
                archivedSessions.map((s: any) => sessionRow(s, true))}
            </div>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="sidebar-action"
            onClick={() => setModal("connections")}
          >
            <SlidersHorizontal size={17} />
            <span>모델 연결</span>
            <span className="count">{totalConnected}</span>
          </button>
          <button className="host-state" onClick={() => setDrawer(true)}>
            <span
              className={cls(
                "status-dot",
                state.runtime.phase === "error" && "failed",
              )}
            />
            <span>로컬 런타임</span>
            <span className="host-state-value">
              {state.runtime.phase === "preparing"
                ? "교체 중"
                : state.runtime.activeVersion
                  ? "실행 중"
                  : "준비 중"}
            </span>
          </button>
          <div className="sidebar-footnote">
            <NodeoffBusiness />
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="메뉴 열기"
              onClick={() => setSideOpen(true)}
            >
              <Menu size={19} />
            </button>
            <span className="crumb-root">Workspace</span>
            <span className="slash">/</span>
            <button
              className="session-title"
              onClick={session ? rename : undefined}
            >
              {session?.title || "새로운 시작"}
            </button>
          </div>
          <div className="top-actions">
            {!connected && (
              <span className="connection-hint">
                <WifiOff size={13} />
                재연결 중
              </span>
            )}
            <button
              className="icon-button"
              aria-label={theme === "dark" ? "라이트 모드로" : "다크 모드로"}
              title={theme === "dark" ? "라이트 모드" : "다크 모드"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            {session && (
              <button
                className="icon-button"
                aria-label="세션 분기"
                title="완료된 대화와 작업 파일로 세션 분기"
                disabled={!!running}
                onClick={fork}
              >
                <GitBranch size={17} />
              </button>
            )}
            <button
              className={cls("workspace-button", drawer && "active")}
              onClick={() => setDrawer((v) => !v)}
            >
              <PanelRight size={16} />
              <span>작업 공간</span>
            </button>
          </div>
        </header>
        <div
          className={cls(
            "conversation",
            !session?.messages.length && !running && "is-empty",
          )}
          ref={scroll}
          onScroll={() => {
            const el = scroll.current!;
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          }}
        >
          {!session?.messages.length && !running ? (
            <div className="welcome">
              <div className="eyebrow">
                <span className="little-line" /> THE BEGINNING OF SOMETHING
              </div>
              <h1>
                생각을 꺼내고,
                <br />
                <span>도구로 만들어보세요.</span>
              </h1>
              <p className="welcome-description">
                아직 정해진 것은 없습니다.
                <br />
                대화하면서 만들고, 실행하고, 조금씩 고쳐갑니다.
              </p>
              <div className="starting-points">
                {[
                  [
                    "01",
                    "빈 작업대에서 시작",
                    "필요한 도구를 하나씩 만들어볼까요?",
                    "먼저 이 작업 공간에서 무엇을 만들고 수정할 수 있는지 간단히 설명해줘.",
                  ],
                  [
                    "02",
                    "반복하는 일을 줄이기",
                    "작은 자동화부터 직접 실행해보세요.",
                    "내 반복 업무를 자동화하는 도구를 함께 만들고 싶어. 어떤 일을 반복하는지 먼저 물어봐줘.",
                  ],
                  [
                    "03",
                    "하네스 자체를 고치기",
                    "지금 쓰고 있는 도구도 바꿀 수 있어요.",
                    "현재 런타임의 구조와 수정 가능한 파일을 살펴보고, 어떻게 함께 고쳐갈 수 있는지 설명해줘.",
                  ],
                ].map(([n, title, desc, prompt]) => (
                  <button
                    key={n}
                    className="starting-point"
                    onClick={() => {
                      setDraft(prompt);
                      textarea.current?.focus();
                    }}
                  >
                    <span className="point-number">{n}</span>
                    <span className="point-text">
                      <strong>{title}</strong>
                      <span>{desc}</span>
                    </span>
                    <ArrowUpRight size={17} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages">
              {session?.parentId && (
                <div className="fork-note">
                  <GitBranch size={13} />
                  완료된 대화에서 분기한 작업 공간
                </div>
              )}
              {session?.messages.map((m: any, i) => (
                <React.Fragment key={m._moru?.id || i}>
                  <Message message={m} />
                  {session.contextCheckpoint?.messageCount === i + 1 && (
                    <details className="context-checkpoint">
                      <summary>대화 문맥 복구 · 이후 응답은 이전 대화 요약에서 이어집니다</summary>
                      <p>원본 대화 {session.contextCheckpoint.messageCount}개는 위 기록에 보존되어 있습니다.</p>
                      <Markdown text={session.contextCheckpoint.summary} />
                    </details>
                  )}
                </React.Fragment>
              ))}
              {session?.partial && (
                <Message message={session.partial} streaming />
              )}
              {activity && (
                <div className="activity">
                  <Loader2 size={14} className="spin" />
                  <span>{activity.toolName}</span>
                  <span className="muted">실행 중</span>
                </div>
              )}
              {running && !session?.partial && !activity && (
                <div className="activity">
                  <span className="thinking-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>
                    {session?.status === "queued"
                      ? "런타임 준비를 기다리는 중"
                      : "생각하고 있습니다"}
                  </span>
                </div>
              )}
              {queued.map((j: any) => (
                <div className="queued-message" key={j.id}>
                  <span>대기 중</span>
                  <p>{j.text}</p>
                </div>
              ))}
              {session?.error && (
                <div className="inline-error">
                  <AlertCircle size={16} />
                  <div>
                    <strong>실행을 완료하지 못했습니다</strong>
                    <p>{session.error}</p>
                    <span>
                      선택한 모델을 유지했습니다. 연결 상태를 확인하고 다시
                      요청할 수 있습니다.
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="composer-wrap">
          <div className="composer">
            <textarea
              ref={textarea}
              aria-label="메시지"
              placeholder={
                running
                  ? "추가로 요청할 내용이 있나요?"
                  : "무엇을 만들고 싶은지 이야기해 주세요…"
              }
              value={draft}
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-toolbar">
              <div className="composer-model">
                <button
                  className="model-trigger"
                  onClick={() => setModal("models")}
                  aria-label="프로바이더와 모델 선택"
                >
                  <span className="model-glyph">
                    {provider?.name?.[0] || "M"}
                  </span>
                  <span>{model?.name || selection.model || "모델 선택"}</span>
                  <ChevronDown size={13} />
                </button>
                {selectedFamily ? (
                  <select
                    className="thinking-select"
                    aria-label="추론 수준"
                    title="같은 모델의 추론 수준을 바꿉니다"
                    value={selection.model}
                    onChange={(e) => {
                      const v = selectedFamily.variants.find(
                        (v) => v.model.id === e.target.value,
                      );
                      if (v)
                        void selectModel({
                          provider: selection.provider,
                          model: v.model.id,
                          thinking: defaultThinking(v.model),
                        });
                    }}
                  >
                    {selectedFamily.variants.map((v) => (
                      <option key={v.model.id} value={v.model.id}>
                        {EFFORT_LABEL[v.effort] ?? v.effort}
                      </option>
                    ))}
                  </select>
                ) : (
                  model &&
                  model.thinkingLevels.length > 1 && (
                    <select
                      className="thinking-select"
                      aria-label="추론 수준"
                      value={selection.thinking}
                      onChange={(e) =>
                        void selectModel({
                          ...selection,
                          thinking: e.target.value,
                        })
                      }
                    >
                      {model.thinkingLevels.map((level) => (
                        <option key={level} value={level}>
                          {level === "off"
                            ? "추론 기본"
                            : (EFFORT_LABEL[level] ?? level)}
                        </option>
                      ))}
                    </select>
                  )
                )}
              </div>
              <div className="send-actions">
                {running && (
                  <button
                    className="stop-button"
                    aria-label="실행 중지"
                    onClick={stop}
                  >
                    <Square size={13} fill="currentColor" />
                  </button>
                )}
                <button
                  className="send-button"
                  aria-label={
                    running ? "메시지 대기열에 추가" : "메시지 보내기"
                  }
                  disabled={!draft.trim() || sending}
                  onClick={send}
                >
                  {sending ? (
                    <Loader2 size={18} className="spin" />
                  ) : (
                    <ArrowUp size={19} />
                  )}
                </button>
              </div>
            </div>
          </div>
          <div className="composer-foot">
            <span>
              {provider?.name || "프로바이더"}
              <span className="separator">·</span>
              {provider?.connected ? "연결됨" : "연결 필요"}
              <span className="separator">·</span>직접 선택한 모델로 대화합니다
            </span>
            <span className="foot-right">
              {contextUsage && (
                <span
                  className={cls(
                    "context-meter",
                    contextUsage.used / contextUsage.total >= 0.85
                      ? "high"
                      : contextUsage.used / contextUsage.total >= 0.6
                        ? "mid"
                        : "",
                  )}
                  title={`마지막 응답 기준 컨텍스트 사용량\n입력 ${(contextUsage.u.input || 0).toLocaleString()} · 캐시 ${((contextUsage.u.cacheRead || 0) + (contextUsage.u.cacheWrite || 0)).toLocaleString()} · 출력 ${(contextUsage.u.output || 0).toLocaleString()}\n${contextUsage.used.toLocaleString()} / ${contextUsage.total.toLocaleString()} 토큰 (${Math.round((contextUsage.used / contextUsage.total) * 100)}%)`}
                >
                  <span className="context-meter-track">
                    <i
                      style={{
                        width: `${Math.min(100, (contextUsage.used / contextUsage.total) * 100)}%`,
                      }}
                    />
                  </span>
                  <span>
                    {fmtTokens(contextUsage.used)} /{" "}
                    {fmtTokens(contextUsage.total)}
                  </span>
                  <span className="context-meter-remain">
                    {fmtTokens(
                      Math.max(contextUsage.total - contextUsage.used, 0),
                    )}{" "}
                    남음
                  </span>
                </span>
              )}
              <span>Shift ↵ 줄바꿈</span>
            </span>
          </div>
        </div>
      </main>
      {drawer && (
        <Workspace
          session={session}
          runtime={state.runtime}
          projectPath={state.projectPath}
          filesEvent={filesEvent}
          onClose={() => setDrawer(false)}
          onError={setError}
        />
      )}
      {modal === "models" && (
        <ModelPicker
          catalog={catalog}
          selection={selection}
          onSelect={selectModel}
          onClose={() => setModal(null)}
          onConnect={() => setModal("connections")}
        />
      )}
      {modal === "connections" && (
        <Connections
          catalog={catalog}
          authEvent={authEvent}
          onClose={() => setModal(null)}
          onError={setError}
        />
      )}
      {error && (
        <div className="toast" role="alert">
          <AlertCircle size={17} />
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="알림 닫기"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <KeyboardNew onNew={() => void openSession(null)} />
    </div>
  );
}

function KeyboardNew({ onNew }: { onNew: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onNew();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onNew]);
  return null;
}
function Message({
  message: m,
  streaming = false,
}: {
  message: any;
  streaming?: boolean;
}) {
  const user = m.role === "user";
  if (m.role === "toolResult")
    return (
      <details className={cls("tool-result", m.isError && "tool-error")}>
        <summary>
          {m.isError ? <AlertCircle size={13} /> : <Check size={13} />}
          <span>{m.toolName}</span>
          <span className="tool-result-label">
            {m.isError ? "실패" : "완료"}
          </span>
          <ChevronDown size={12} />
        </summary>
        <pre>
          {(m.content || [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n")}
        </pre>
      </details>
    );
  const content =
    typeof m.content === "string"
      ? [{ type: "text", text: m.content }]
      : m.content || [];
  const text = content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
  const calls = content.filter((c: any) => c.type === "toolCall");
  if (!text && !calls.length && !streaming) return null;
  return (
    <article
      className={cls("message", user ? "user-message" : "assistant-message")}
    >
      <div className="message-meta">
        <span className={cls("message-avatar", !user && "agent-avatar")}>
          {user ? "나" : "m"}
        </span>
        <strong>{user ? "You" : "Moru"}</strong>
        {!user && (
          <span className="message-model">
            {m._moru?.selection?.model || m.model}
          </span>
        )}
        <time>{date(m.timestamp)}</time>
        {!streaming && text && (
          <button
            className="copy-message icon-button"
            aria-label="메시지 복사"
            onClick={(e) => {
              const button = e.currentTarget;
              void copyText(text)
                .then(() => { button.title = "복사됨"; })
                .catch(() => { button.title = "복사 실패"; });
            }}
          >
            <Copy size={13} />
          </button>
        )}
      </div>
      {text ? (
        <Markdown text={text} streaming={streaming} />
      ) : streaming ? (
        <div className="thinking-label">응답을 준비하고 있습니다…</div>
      ) : null}
      {calls.map((c: any) => (
        <details className="tool-call" key={c.id}>
          <summary>
            <Terminal size={13} />
            <span>{c.name}</span>
            <ChevronDown size={12} />
          </summary>
          <pre>{JSON.stringify(c.arguments, null, 2)}</pre>
        </details>
      ))}
    </article>
  );
}

function Modal({
  children,
  onClose,
  className = "",
}: {
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={cls("modal", className)}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-inner">{children}</div>
    </dialog>
  );
}
function ModelPicker({
  catalog,
  selection,
  onSelect,
  onClose,
  onConnect,
}: {
  catalog: CatalogProvider[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  onClose: () => void;
  onConnect: () => void;
}) {
  const [providerId, setProviderId] = useState(
    selection.provider || catalog[0]?.id,
  );
  const [query, setQuery] = useState("");
  const p = catalog.find((p) => p.id === providerId);
  const families = useMemo(() => buildFamilies(p?.models ?? []), [p]);
  const isSelected = (f: ModelFamily) =>
    selection.provider === p?.id &&
    f.variants.some((v) => v.model.id === selection.model);
  const q = query.trim().toLowerCase();
  const shown = families
    .filter(
      (f) =>
        !q ||
        f.name.toLowerCase().includes(q) ||
        f.variants.some(
          (v) =>
            v.model.id.toLowerCase().includes(q) ||
            v.model.name.toLowerCase().includes(q),
        ),
    )
    .sort((a, b) => Number(isSelected(b)) - Number(isSelected(a)));
  return (
    <Modal onClose={onClose} className="model-modal">
      <div className="modal-header">
        <div>
          <div className="eyebrow">YOUR CHOICE</div>
          <h2>함께할 모델을 고르세요.</h2>
        </div>
        <button
          className="icon-button"
          aria-label="모델 선택 닫기"
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      <div className="model-browser">
        <div className="provider-list">
          {catalog.map((p) => (
            <button
              key={p.id}
              className={cls(
                "provider-option",
                p.id === providerId && "selected",
              )}
              onClick={() => {
                setProviderId(p.id);
                setQuery("");
              }}
            >
              <span
                className={cls("provider-status", p.connected && "connected")}
              />
              <span>{p.name}</span>
            </button>
          ))}
        </div>
        <div className="model-list-panel">
          <div className="model-search">
            <Search size={15} />
            <input
              autoFocus
              aria-label="모델 검색"
              placeholder="모델 이름 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="model-provider-meta">
            <span>{p?.name}</span>
            <span>{p?.connected ? p.source || "연결됨" : "연결 필요"}</span>
          </div>
          <div className="model-options">
            {shown.map((f) => {
              const selected = isSelected(f);
              const active =
                f.variants.find(
                  (v) => selected && v.model.id === selection.model,
                ) ?? defaultVariant(f);
              const m = active.model;
              return (
                <div
                  key={f.key}
                  className={cls("model-option", selected && "selected")}
                >
                  <button
                    className="model-option-head"
                    onClick={() =>
                      onSelect({
                        provider: p!.id,
                        model: m.id,
                        thinking:
                          selected && !f.grouped
                            ? selection.thinking
                            : defaultThinking(m),
                      })
                    }
                  >
                    <span className="model-option-text">
                      <strong>{f.name}</strong>
                      <small>{m.id}</small>
                    </span>
                    <span className="model-context">
                      {m.contextWindow
                        ? Math.round(m.contextWindow / 1000) + "k"
                        : ""}
                      {!f.grouped && m.thinkingLevels.length > 1 && (
                        <span className="model-levels">
                          추론 {m.thinkingLevels.length}단계
                        </span>
                      )}
                      {selected && <Check size={16} />}
                    </span>
                  </button>
                  {f.grouped && f.variants.length > 1 && (
                    <div
                      className="effort-chips"
                      role="group"
                      aria-label="추론 수준"
                    >
                      {f.variants.map((v) => (
                        <button
                          key={v.model.id}
                          className={cls(
                            "effort-chip",
                            selected &&
                              v.model.id === selection.model &&
                              "active",
                          )}
                          title={v.model.name}
                          onClick={() =>
                            onSelect({
                              provider: p!.id,
                              model: v.model.id,
                              thinking: defaultThinking(v.model),
                            })
                          }
                        >
                          {EFFORT_LABEL[v.effort] ?? v.effort}
                        </button>
                      ))}
                    </div>
                  )}
                  {!f.grouped && selected && m.thinkingLevels.length > 1 && (
                    <div
                      className="effort-chips"
                      role="group"
                      aria-label="추론 수준"
                    >
                      {m.thinkingLevels.map((level) => (
                        <button
                          key={level}
                          className={cls(
                            "effort-chip",
                            selection.thinking === level && "active",
                          )}
                          onClick={() =>
                            onSelect({
                              provider: p!.id,
                              model: m.id,
                              thinking: level,
                            })
                          }
                        >
                          {level === "off"
                            ? "Off"
                            : (EFFORT_LABEL[level] ?? level)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {!p?.models.length && (
              <p className="empty-small">
                {p?.error || "연결 후 모델 목록을 새로고침하세요."}
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <span>변경한 모델은 다음 메시지부터 사용합니다.</span>
        <button className="text-button" onClick={onConnect}>
          <Plug size={15} />
          프로바이더 연결
        </button>
      </div>
    </Modal>
  );
}

function Connections({
  catalog,
  authEvent,
  onClose,
  onError,
}: {
  catalog: CatalogProvider[];
  authEvent: number;
  onClose: () => void;
  onError: (e: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [flowId, setFlowId] = useState<string | null>(() =>
    sessionStorage.getItem("moru.authFlow"),
  );
  const [flow, setFlow] = useState<any>(null);
  const [answer, setAnswer] = useState("");
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (flowId) sessionStorage.setItem("moru.authFlow", flowId);
    else sessionStorage.removeItem("moru.authFlow");
  }, [flowId]);
  useEffect(() => {
    if (flowId)
      void api("/auth/flow/" + flowId)
        .then(setFlow)
        .catch((e) => onError(e.message));
  }, [flowId, authEvent]);
  useEffect(() => {
    setAnswer(
      flow?.prompt?.type === "select" ? flow.prompt.options[0]?.id || "" : "",
    );
  }, [flow?.prompt?.token]);
  async function connect(provider: string, type: string) {
    try {
      const result = await api("/auth/start", { provider, type });
      setFlowId(result.id);
    } catch (e: any) {
      onError(e.message);
    }
  }
  async function submit() {
    try {
      await api("/auth/answer", {
        id: flowId,
        token: flow.prompt.token,
        value: answer,
      });
      setAnswer("");
    } catch (e: any) {
      onError(e.message);
    }
  }
  async function refresh() {
    setBusy(true);
    try {
      await api("/providers/refresh", {});
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (flowId && flow?.status === "running")
      await api("/auth/cancel", { id: flowId });
    setFlow(null);
    setFlowId(null);
  }
  return (
    <Modal onClose={onClose} className="connections-modal">
      <div className="modal-header">
        <div>
          <div className="eyebrow">CONNECTIONS</div>
          <h2>모델은 당신의 선택으로.</h2>
          <p>인증은 이 컴퓨터에 저장되고 런타임 교체 후에도 유지됩니다.</p>
        </div>
        <button
          className="icon-button"
          aria-label="연결 창 닫기"
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      {custom ? (
        <CustomProvider
          onBack={() => setCustom(false)}
          onSaved={() => setCustom(false)}
          onError={onError}
        />
      ) : flowId ? (
        <div className="auth-flow">
          <button className="text-button" onClick={() => void cancel()}>
            <ArrowLeft size={14} />
            연결 목록
          </button>
          <h3>
            {catalog.find((p) => p.id === flow?.provider)?.name ||
              "인증 준비 중"}
          </h3>
          {flow?.events.map((event: any, i: number) => (
            <div className="auth-event" key={i}>
              {event.message && <p>{event.message}</p>}
              {event.type === "auth_url" && (
                <>
                  <a
                    className="button dark"
                    href={event.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    브라우저에서 로그인
                    <ArrowUpRight size={14} />
                  </a>
                  {event.instructions && <p>{event.instructions}</p>}
                </>
              )}
              {event.type === "device_code" && (
                <>
                  <p>
                    연결 코드 <code>{event.userCode}</code>
                  </p>
                  <a
                    href={event.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                  >
                    인증 페이지 열기 ↗
                  </a>
                </>
              )}
              {event.links?.map((link: any) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {link.label || "안내 열기"} ↗
                </a>
              ))}
            </div>
          ))}
          {flow?.prompt && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <label className="field-label">
                {flow.prompt.message}
                {flow.prompt.type === "select" ? (
                  <select
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                  >
                    {flow.prompt.options.map((o: any) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    autoFocus
                    autoComplete="off"
                    type={flow.prompt.type === "secret" ? "password" : "text"}
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder={flow.prompt.placeholder || ""}
                  />
                )}
              </label>
              <button className="button dark" type="submit" disabled={!answer}>
                계속
                <ArrowUpRight size={14} />
              </button>
            </form>
          )}
          {flow?.status === "completed" && (
            <div className="auth-success">
              <CheckCircle2 size={19} />
              연결되었습니다. 모델 목록에서 선택할 수 있습니다.
            </div>
          )}
          {flow?.error && <p className="error-text">{flow.error}</p>}
          {flow?.status === "running" && !flow.prompt && (
            <p className="muted">
              <Loader2 size={14} className="spin" /> 인증을 기다리는 중
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="connections-toolbar">
            <div className="model-search">
              <Search size={15} />
              <input
                aria-label="프로바이더 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="프로바이더 검색"
              />
            </div>
            <button
              className="icon-button"
              aria-label="모델 목록 새로고침"
              disabled={busy}
              onClick={refresh}
            >
              <RotateCw size={16} className={busy ? "spin" : ""} />
            </button>
          </div>
          <div className="connections-list">
            {catalog
              .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
              .map((p) => (
                <div key={p.id} className="connection-row">
                  <span className="provider-monogram">{p.name[0]}</span>
                  <div className="connection-info">
                    <strong>{p.name}</strong>
                    <span>
                      {p.connected
                        ? p.source || "연결됨"
                        : p.error || `${p.models.length}개 모델`}
                    </span>
                  </div>
                  <div className="connection-actions">
                    {p.connected ? (
                      <>
                        <span className="connected-label">
                          <Check size={12} />
                          연결됨
                        </span>
                        {p.id !== "devin" && (
                          <button
                            className="text-button subdued"
                            onClick={() =>
                              void api("/auth/logout", {
                                provider: p.id,
                              }).catch((e) => onError(e.message))
                            }
                          >
                            해제
                          </button>
                        )}
                      </>
                    ) : (
                      p.methods.map((method) => (
                        <button
                          key={method.type}
                          className="button small"
                          onClick={() => void connect(p.id, method.type)}
                        >
                          {method.type === "oauth" ? "로그인" : "API 키"}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              ))}
          </div>
          <div className="modal-footer">
            <span>pi 인증 관리 · 선택한 모델을 그대로 사용</span>
            <button className="text-button" onClick={() => setCustom(true)}>
              <Plus size={15} />
              사용자 지정 연결
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
function CustomProvider({ onBack, onSaved, onError }: any) {
  const [form, setForm] = useState({
    id: "",
    name: "",
    baseUrl: "",
    api: "openai-completions",
    apiKey: "",
    modelIds: "",
    keyless: false,
  });
  const [busy, setBusy] = useState(false);
  const field = (key: keyof typeof form) => ({
    value: String(form[key]),
    onChange: (e: any) => setForm((s) => ({ ...s, [key]: e.target.value })),
  });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/providers/custom", {
        ...form,
        models: form.modelIds
          .split("\n")
          .filter((v) => v.trim())
          .map((id) => ({ id: id.trim() })),
      });
      onSaved();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="custom-form" onSubmit={submit}>
      <button className="text-button" type="button" onClick={onBack}>
        <ArrowLeft size={14} />
        연결 목록
      </button>
      <div className="form-columns">
        <label className="field-label">
          이름
          <input required placeholder="My provider" {...field("name")} />
        </label>
        <label className="field-label">
          프로바이더 ID
          <input
            required
            pattern="[a-z][a-z0-9-]{1,50}"
            placeholder="my-provider"
            {...field("id")}
          />
        </label>
      </div>
      <label className="field-label">
        API 주소
        <input
          required
          type="url"
          placeholder="http://localhost:11434/v1"
          {...field("baseUrl")}
        />
      </label>
      <label className="field-label">
        API 형식
        <select {...field("api")}>
          <option value="openai-completions">
            OpenAI Chat Completions 호환
          </option>
          <option value="openai-responses">OpenAI Responses 호환</option>
          <option value="anthropic-messages">Anthropic Messages 호환</option>
        </select>
      </label>
      <label className="field-label">
        모델 ID <span>한 줄에 하나씩 입력</span>
        <textarea
          required
          rows={3}
          placeholder="model-name"
          {...field("modelIds")}
        />
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={form.keyless}
          onChange={(e) =>
            setForm((s) => ({ ...s, keyless: e.target.checked }))
          }
        />
        인증이 필요 없는 로컬 서버
      </label>
      {!form.keyless && (
        <label className="field-label">
          API 키
          <input
            required
            type="password"
            autoComplete="off"
            {...field("apiKey")}
          />
        </label>
      )}
      <button className="button dark" disabled={busy}>
        {busy ? "저장 중…" : "연결 추가"}
        <Plus size={15} />
      </button>
    </form>
  );
}

function Workspace({
  session,
  runtime,
  projectPath,
  filesEvent,
  onClose,
  onError,
}: any) {
  const [scope, setScope] = useState("workspace");
  const [files, setFiles] = useState<any[]>([]);
  const [file, setFile] = useState<any>(null);
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [hostRestarting, setHostRestarting] = useState(false);
  const query = `?scope=${scope}&sessionId=${session?.id || ""}`;
  useEffect(() => {
    setFile(null);
  }, [scope, session?.id]);
  useEffect(() => {
    if (scope === "runtime" || session)
      void api("/files" + query)
        .then((v) => setFiles(v.files))
        .catch((e: any) => onError(e.message));
    else setFiles([]);
  }, [scope, session?.id, filesEvent]);
  async function open(path: string) {
    try {
      const f = await api(
        "/files" + query + "&path=" + encodeURIComponent(path),
      );
      setFile(f);
      setContent(f.content);
      setSaved(false);
    } catch (e: any) {
      onError(e.message);
    }
  }
  async function save() {
    try {
      await api("/files", {
        scope,
        sessionId: session?.id,
        path: file.path,
        content,
      });
      setFile({ ...file, content });
      setSaved(true);
    } catch (e: any) {
      onError(e.message);
    }
  }
  async function restart() {
    setRestarting(true);
    try {
      await api("/runtime/restart", {
        reason: "작업 공간에서 런타임 교체 요청",
      });
    } catch (e: any) {
      onError(e.message);
    } finally {
      setRestarting(false);
    }
  }
  async function restartHost() {
    setHostRestarting(true);
    try {
      await api("/host/restart", {});
      // The screen reloads once the new host republishes the build event.
    } catch (e: any) {
      setHostRestarting(false);
      onError(e.message);
    }
  }
  return (
    <aside className="workspace-drawer">
      <div className="drawer-header">
        <h2>작업 공간</h2>
        <button
          className="icon-button"
          aria-label="작업 공간 닫기"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <div className="runtime-overview">
        <div className="eyebrow">LIVE RUNTIME</div>
        <div className="runtime-current">
          <span
            className={cls("status-dot", runtime.phase === "error" && "failed")}
          />
          <strong>
            {runtime.phase === "preparing"
              ? "새 버전 준비 중"
              : runtime.activeVersion
                ? "실행 중"
                : "준비 중"}
          </strong>
          <code>{runtime.activeVersion?.split("-").at(-1)}</code>
        </div>
        <p>
          대화와 인증은 호스트에 유지됩니다.
          <br />
          진행 중인 작업은 기존 버전에서 마칩니다.
        </p>
        <button
          className="button"
          disabled={restarting || runtime.phase === "preparing"}
          onClick={restart}
        >
          <RotateCw size={14} className={restarting ? "spin" : ""} />
          런타임 교체
        </button>
        <button
          className="button"
          disabled={hostRestarting}
          title="호스트 프로세스를 새 코드로 교체합니다. 실행 중인 작업은 중단되고 화면이 새로고침됩니다."
          onClick={restartHost}
        >
          <RotateCw size={14} className={hostRestarting ? "spin" : ""} />
          {hostRestarting ? "호스트 재시작 중…" : "호스트 재시작"}
        </button>
        {runtime.error && <p className="error-text">{runtime.error}</p>}
        <div className="process-list">
          {runtime.processes?.map((p: any) => (
            <div key={p.version}>
              <span>
                {p.state === "active"
                  ? "현재 버전"
                  : p.state === "draining"
                    ? "작업 마무리 중"
                    : "준비 중"}
              </span>
              <code>{p.pid}</code>
              <span>{p.jobs}개 작업</span>
            </div>
          ))}
        </div>
      </div>
      <div className="drawer-tabs">
        <button
          className={scope === "workspace" ? "active" : ""}
          onClick={() => setScope("workspace")}
        >
          세션 파일
        </button>
        <button
          className={scope === "runtime" ? "active" : ""}
          onClick={() => setScope("runtime")}
        >
          Moru 소스
        </button>
      </div>
      <div className="file-area">
        {file ? (
          <>
            <div className="file-heading">
              <button
                className="icon-button"
                aria-label="파일 목록"
                onClick={() => setFile(null)}
              >
                <ArrowLeft size={15} />
              </button>
              <code>{file.path}</code>
            </div>
            <textarea
              className="file-editor"
              aria-label="파일 내용"
              spellCheck={false}
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setSaved(false);
              }}
            />
            <div className="editor-footer">
              <span>
                {file.path === "src/runtime.ts"
                  ? "저장 후 런타임을 교체하세요."
                  : "다음 실행에 반영됩니다."}
              </span>
              <button
                className="button dark small"
                disabled={
                  content === file.content ||
                  (scope === "workspace" && !session)
                }
                onClick={save}
              >
                {saved ? "저장됨" : "저장"}
              </button>
            </div>
          </>
        ) : (
          <>
            {files.length ? (
              <div className="file-list">
                {files.map((f) => (
                  <button
                    key={f.path}
                    className="file-row"
                    disabled={f.directory}
                    onClick={() => void open(f.path)}
                  >
                    {f.directory ? (
                      <Folder size={15} />
                    ) : (
                      <FileText size={15} />
                    )}
                    <span>{f.path}</span>
                    {!f.directory && <ChevronRight size={13} />}
                  </button>
                ))}
              </div>
            ) : (
              <div className="files-empty">
                <FileText size={22} />
                <p>
                  첫 대화를 시작하면
                  <br />이 세션의 작업 폴더가 만들어집니다.
                </p>
              </div>
            )}
            <div className="workspace-note">
              {scope === "workspace"
                ? "instructions.md에서 지침을, tools/에서 도구를 수정할 수 있습니다."
                : "화면은 저장하면 다시 빌드됩니다. 런타임 코드는 별도 프로세스로 교체됩니다."}
            </div>
          </>
        )}
      </div>
      <div className="drawer-path">{projectPath}</div>
    </aside>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
