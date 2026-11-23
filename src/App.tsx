import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ChapterList } from "./components/ChapterList";
import { HelpDialog } from "./components/HelpDialog";
import { PreviewPane } from "./components/PreviewPane";
import { openPdfSession } from "./lib/pdfSession";
import type { ChapterRecord, InspectResult, Issue, SavedProgress } from "./lib/types";
import { buildRecordFile, parseRecordFile } from "./lib/recordsFile";
import { HEADING_UNITS, isBlankChapter, joinPath, sanitizeComponent, sortRecords, validate } from "./lib/validate";
import appMeta from "../package.json";

const EDIT_RATIO_KEY = "pdf-splitter.editRatio";
const LAST_SESSION_KEY = "pdf-splitter.lastSession";

type LastSession = { pdfPath: string; configPath: string };

function readSession(): LastSession | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_SESSION_KEY) ?? "");
    if (!raw || typeof raw.pdfPath !== "string") return null;
    return { pdfPath: raw.pdfPath, configPath: typeof raw.configPath === "string" ? raw.configPath : "" };
  } catch {
    return null;
  }
}

function writeSession(pdfPath: string, configPath: string) {
  if (!pdfPath) return;
  localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ pdfPath, configPath }));
}

function loadEditRatio(): number {
  const saved = Number(localStorage.getItem(EDIT_RATIO_KEY));
  return Number.isFinite(saved) && saved >= 0.25 && saved <= 0.75 ? saved : 0.5;
}

type Snapshot = {
  pdfPath: string;
  bookId: string;
  bookTitle: string;
  outputDir: string;
  sourceDir: string;
  configPath: string;
  headingUnit: string;
  chapters: ChapterRecord[];
  page: number;
  autosave: boolean;
};

type PendingRestore = {
  progress: SavedProgress;
  info: InspectResult;
};

export default function App() {
  const [pdfPath, setPdfPath] = useState("");
  const [bookId, setBookId] = useState("");
  const [bookTitle, setBookTitle] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [renameAsk, setRenameAsk] = useState<string | null>(null);
  const [closeAfterRename, setCloseAfterRename] = useState(false);
  const [headingUnit, setHeadingUnit] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [sourceDir, setSourceDir] = useState("");
  const [outputPicked, setOutputPicked] = useState(false);
  const [editRatio, setEditRatio] = useState(loadEditRatio);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [chapters, setChapters] = useState<ChapterRecord[]>([]);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<ReturnType<typeof parseRecordFile> | null>(null);
  const importPathRef = useRef("");
  const [reveal, setReveal] = useState(0);
  const activeIdRef = useRef<string | null>(null);
  const [autosave, setAutosave] = useState(false);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState<{ current: number; total: number; title: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [closeAsk, setCloseAsk] = useState(false);
  const [resultDir, setResultDir] = useState("");
  const order = useRef(1);
  const pdfSession = useRef<{ destroy: () => Promise<void> } | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const editRatioRef = useRef(editRatio);
  const configPathRef = useRef(readSession()?.configPath ?? "");
  const titleDraftRef = useRef("");
  const closingRef = useRef(false);
  const snapshot = useRef<Snapshot>({
    pdfPath: "",
    bookId: "",
    bookTitle: "",
    outputDir: "",
    sourceDir: "",
    configPath: "",
    headingUnit: "",
    chapters: [],
    page: 1,
    autosave: false,
  });

  const sorted = useMemo(() => sortRecords(chapters), [chapters]);
  const plan = useMemo(
    () => validate(bookTitle, outputDir, pageCount, chapters, headingUnit),
    [bookTitle, outputDir, pageCount, chapters, headingUnit],
  );
  const defaultSplitPath = sourceDir
    ? plan.directoryName
      ? joinPath(sourceDir, plan.directoryName)
      : sourceDir
    : "";
  const splitTarget = outputPicked ? outputDir : defaultSplitPath;
  const errorIds = new Set(plan.errors.flatMap((issue) => (issue.recordId ? [issue.recordId] : [])));
  const warningIds = new Set(plan.warnings.flatMap((issue) => (issue.recordId ? [issue.recordId] : [])));
  const showChecks = Boolean(pdfPath) || chapters.some((item) => !isBlankChapter(item));

  snapshot.current = {
    pdfPath,
    bookId,
    bookTitle,
    outputDir,
    sourceDir,
    configPath: configPathRef.current,
    headingUnit,
    chapters,
    page,
    autosave,
  };
  editRatioRef.current = editRatio;
  titleDraftRef.current = titleDraft;

  const flushSave = useCallback(async (current = snapshot.current) => {
    if (!current.autosave || !current.bookId) return;
    await invoke("save_progress_cmd", {
      bookId: current.bookId,
      draft: {
        bookTitle: current.bookTitle,
        outputDir: current.outputDir,
        headingUnit: current.headingUnit,
        chapters: current.chapters,
        lastPage: current.page,
      },
    });
  }, []);

  useEffect(() => {
    if (!autosave || !bookId) return;
    const timer = window.setTimeout(() => {
      void flushSave().catch((reason: unknown) => setFailure(textOf(reason)));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [autosave, bookId, bookTitle, outputDir, headingUnit, chapters, page, flushSave]);

  useEffect(() => {
    let unlisten = () => {};
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        const current = snapshot.current;
        const next = titleDraftRef.current.trim();
        if (next !== current.bookTitle && current.chapters.some((item) => !isBlankChapter(item))) {
          setTitleDraft(next);
          setRenameAsk(next);
          setCloseAfterRename(true);
          return;
        }
        if (next !== current.bookTitle) {
          setBookTitle(next);
          snapshot.current = { ...current, bookTitle: next };
        }
        setCloseAsk(true);
      })
      .then((stop) => {
        unlisten = stop;
      });
    return () => unlisten();
  }, []);

  useEffect(() => {
    setTitleDraft(bookTitle);
  }, [bookTitle]);

  useEffect(() => {
    const session = readSession();
    if (!session?.pdfPath || !session.configPath) return;
    let cancelled = false;
    void (async () => {
      setBusy("正在恢复上次的书籍…");
      try {
        const info = await invoke<InspectResult>("inspect_pdf", { path: session.pdfPath });
        const text = await invoke<string>("read_text_file", { path: session.configPath });
        const imported = parseRecordFile(text);
        if (cancelled) return;
        setPdfPath(session.pdfPath);
        setBookId(info.bookId);
        setSourceDir(info.parentDir);
        configPathRef.current = session.configPath;
        await loadDocument(info);
        if (cancelled) return;
        const saved = info.progress;
        setBookTitle((imported.bookTitle.trim() || info.defaultTitle).trim());
        setHeadingUnit(imported.headingUnit);
        setOutputDir(saved?.outputDir || info.parentDir);
        setOutputPicked(Boolean(saved?.outputDir && saved.outputDir !== info.parentDir));
        setChapters(imported.chapters);
        rememberOrder(imported.chapters);
        setPage(Math.min(info.pageCount, Math.max(1, saved?.lastPage || 1)));
        setPageCount(info.pageCount);
        setAutosave(true);
        setNotice(`已恢复上次的书籍和 ${imported.chapters.length} 条拆分记录。`);
      } catch {
        if (!cancelled) localStorage.removeItem(LAST_SESSION_KEY);
      } finally {
        if (!cancelled) setBusy("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.key === "ArrowLeft") setPage((current) => Math.max(1, current - 1));
      if (event.key === "ArrowRight") setPage((current) => Math.min(pageCount || 1, current + 1));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageCount]);

  function rememberOrder(items: ChapterRecord[]) {
    order.current = items.reduce((max, item) => Math.max(max, item.manualOrder), 0) + 1;
  }

  async function loadDocument(info: InspectResult) {
    const session = await openPdfSession(info.fileSize);
    await pdfSession.current?.destroy();
    pdfSession.current = session;
    setPdfDocument(session.document);
  }

  function applyFresh(info: InspectResult) {
    setBookTitle(info.defaultTitle);
    setHeadingUnit("");
    setSourceDir(info.parentDir);
    setOutputDir(info.parentDir);
    setOutputPicked(false);
    setChapters([]);
    setPage(1);
    setPageCount(info.pageCount);
    rememberOrder([]);
    setAutosave(true);
  }

  function applyProgress(info: InspectResult, saved: SavedProgress) {
    setBookTitle(saved.bookTitle);
    setHeadingUnit(saved.headingUnit ?? "");
    setSourceDir(info.parentDir);
    setOutputPicked(saved.outputDir !== "" && saved.outputDir !== info.parentDir);
    setOutputDir(saved.outputDir || info.parentDir);
    setChapters(saved.chapters.filter((item) => !isBlankChapter(item)));
    setPage(Math.min(info.pageCount, Math.max(1, saved.lastPage || 1)));
    setPageCount(info.pageCount);
    rememberOrder(saved.chapters);
    setAutosave(true);
  }

  async function choosePdf() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof selected !== "string") return;
    setFailure("");
    setNotice("");
    setResultDir("");
    setPending(null);
    setAutosave(false);
    await flushSave();
    setBusy("正在打开 PDF…");
    try {
      const info = await invoke<InspectResult>("inspect_pdf", { path: selected });
      setPdfPath(selected);
      setBookId(info.bookId);
      setSourceDir(info.parentDir);
      configPathRef.current = "";
      writeSession(selected, "");
      await loadDocument(info);
      const saved = info.progress;
      const meaningful =
        saved != null &&
        (saved.chapters.length > 0 ||
          saved.bookTitle !== info.defaultTitle ||
          Boolean(saved.headingUnit) ||
          (saved.outputDir !== "" && saved.outputDir !== info.parentDir) ||
          saved.lastPage > 1);
      if (saved && meaningful) {
        setOutputPicked(false);
        setPageCount(info.pageCount);
        setPending({ progress: saved, info });
      } else {
        applyFresh(info);
      }
    } catch (reason) {
      setFailure(textOf(reason));
    } finally {
      setBusy("");
    }
  }

  function revealStart(start: number | null) {
    if (start == null || pageCount <= 0) return;
    setPage(Math.min(pageCount, Math.max(1, start)));
    setReveal((current) => current + 1);
  }

  function activateRow(id: string) {
    const changed = activeIdRef.current !== id;
    activeIdRef.current = id;
    setActiveId(id);
    if (!changed) return;
    const chapter = chapters.find((item) => item.id === id);
    revealStart(chapter?.startPage ?? null);
  }

  function pickIndex(id: string) {
    activeIdRef.current = id;
    setActiveId(id);
    const chapter = chapters.find((item) => item.id === id);
    revealStart(chapter?.startPage ?? null);
  }

  const activeChapter = chapters.find((item) => item.id === activeId) ?? null;
  const activeStart = activeChapter?.startPage ?? null;
  const highlight = (() => {
    if (activeChapter?.startPage == null || activeChapter.endPage == null || pageCount <= 0) return null;
    if (activeChapter.startPage > activeChapter.endPage) return null;
    const start = Math.max(1, activeChapter.startPage);
    const end = Math.min(pageCount, activeChapter.endPage);
    return start <= end ? { start, end } : null;
  })();

  useEffect(() => {
    if (!activeId || activeStart == null) return;
    revealStart(activeStart);
  }, [activeId, activeStart, pageCount]);

  function updateChapter(id: string, patch: Partial<ChapterRecord>) {
    setChapters((current) =>
      current.flatMap((item) => {
        if (item.id !== id) return [item];
        const next = { ...item, ...patch };
        return isBlankChapter(next) ? [] : [next];
      }),
    );
    setResultDir("");
  }

  function commitDraft(record: ChapterRecord) {
    if (isBlankChapter(record)) return;
    setChapters((current) => {
      if (current.some((item) => item.id === record.id)) return current;
      return [...current, { ...record, manualOrder: order.current++ }];
    });
    setResultDir("");
  }

  function moveChapter(id: string, direction: -1 | 1) {
    const list = sortRecords(chapters);
    const index = list.findIndex((item) => item.id === id);
    const neighbor = list[index + direction];
    const current = list[index];
    if (!current || !neighbor || current.startPage !== neighbor.startPage || current.endPage !== neighbor.endPage) {
      return;
    }
    const neighborOrder =
      neighbor.manualOrder === current.manualOrder ? current.manualOrder + direction : neighbor.manualOrder;
    setChapters((items) =>
      items.map((item) => {
        if (item.id === current.id) return { ...item, manualOrder: neighborOrder };
        if (item.id === neighbor.id) return { ...item, manualOrder: current.manualOrder };
        return item;
      }),
    );
  }

  function applyImported(imported: ReturnType<typeof parseRecordFile>) {
    activeIdRef.current = null;
    setActiveId(null);
    setHeadingUnit(imported.headingUnit);
    setChapters(imported.chapters);
    order.current = imported.chapters.reduce((max, item) => Math.max(max, item.manualOrder), 0) + 1;
    setResultDir("");
    setFailure("");
    if (importPathRef.current) {
      configPathRef.current = importPathRef.current;
      writeSession(snapshot.current.pdfPath, importPathRef.current);
    }
    const sourceTitle = imported.bookTitle.trim();
    const titleNote = sourceTitle && sourceTitle !== bookTitle.trim() ? `文件中的书籍总名是「${sourceTitle}」。` : "";
    setNotice(`已导入 ${imported.chapters.length} 条拆分记录。${titleNote}`);
  }

  function rememberConfig(path: string) {
    configPathRef.current = path;
    writeSession(snapshot.current.pdfPath, path);
  }

  async function writeConfigFile(current: Snapshot) {
    const name = sanitizeComponent(current.bookTitle);
    if (!name) throw new Error("书籍总名无效，无法导出配置。");
    const fileName = `${name}.json`;
    let path = fileName;
    if (current.configPath) {
      const slash = Math.max(current.configPath.lastIndexOf("\\"), current.configPath.lastIndexOf("/"));
      const dir = slash >= 0 ? current.configPath.slice(0, slash) : "";
      path = dir ? joinPath(dir, fileName) : fileName;
    } else if (current.outputDir || current.sourceDir) {
      path = joinPath(current.outputDir || current.sourceDir, fileName);
    } else {
      throw new Error("没有可写入配置的目录。");
    }
    const payload = buildRecordFile(current.bookTitle.trim(), current.headingUnit, current.chapters);
    await invoke("write_text_file", { path, contents: `${JSON.stringify(payload, null, 2)}\n` });
    rememberConfig(path);
    return payload.chapters.length;
  }

  function commitTitle() {
    const next = titleDraft.trim();
    if (next !== titleDraft) setTitleDraft(next);
    if (next === bookTitle) return;
    if (next === bookTitle.trim()) {
      setBookTitle(next);
      return;
    }
    if (chapters.some((item) => !isBlankChapter(item))) {
      setRenameAsk(next);
      return;
    }
    setBookTitle(next);
  }

  async function confirmClose() {
    if (closingRef.current) return;
    closingRef.current = true;
    const current = snapshot.current;
    setCloseAsk(false);
    try {
      if (current.chapters.some((item) => !isBlankChapter(item))) {
        const count = await writeConfigFile(current);
        setNotice(`已导出 ${count} 条拆分记录。`);
      }
      await flushSave(current);
      await getCurrentWindow().destroy();
    } catch (reason) {
      closingRef.current = false;
      setFailure(textOf(reason));
    }
  }

  async function exportRecords() {
    const name = sanitizeComponent(bookTitle);
    if (!name) {
      setFailure("书籍总名无效，无法作为导出文件名。");
      return;
    }
    if (chapters.filter((item) => !isBlankChapter(item)).length === 0) {
      setFailure("还没有可导出的拆分记录。");
      return;
    }
    try {
      const selected = await save({
        title: "导出拆分记录",
        defaultPath: outputDir ? joinPath(outputDir, `${name}.json`) : `${name}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected) return;
      const payload = buildRecordFile(bookTitle.trim(), headingUnit, chapters);
      await invoke("write_text_file", { path: selected, contents: `${JSON.stringify(payload, null, 2)}\n` });
      rememberConfig(selected);
      setFailure("");
      setNotice(`已导出 ${payload.chapters.length} 条拆分记录。`);
    } catch (reason) {
      setFailure(textOf(reason));
    }
  }

  async function importRecords() {
    try {
      const selected = await open({
        title: "导入拆分记录",
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof selected !== "string") return;
      const text = await invoke<string>("read_text_file", { path: selected });
      importPathRef.current = selected;
      const imported = parseRecordFile(text);
      if (chapters.some((item) => !isBlankChapter(item))) {
        setPendingImport(imported);
        return;
      }
      applyImported(imported);
    } catch (reason) {
      setFailure(textOf(reason));
    }
  }

  async function chooseOutput() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      setOutputDir(selected);
      setOutputPicked(true);
      setResultDir("");
    }
  }

  async function startSplit(force = false) {
    if (!pdfPath || plan.errors.length > 0) return;
    if (!force && plan.warnings.length > 0) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setFailure("");
    setNotice("");
    await flushSave();
    setBusy("正在拆分…");
    setProgress({ current: 0, total: plan.files.length, title: "" });
    const stop = await listen<{ current: number; total: number; title: string }>("split-progress", (event) => {
      setProgress(event.payload);
    });
    try {
      const outcome = await invoke<{ directory: string; files: string[] }>("split_pdf", {
        path: pdfPath,
        bookTitle,
        outputDir,
        records: chapters,
        headingUnit,
      });
      setResultDir(outcome.directory);
      setNotice(`已拆成 ${outcome.files.length} 个文件。`);
    } catch (reason) {
      setFailure(textOf(reason));
    } finally {
      stop();
      setProgress(null);
      setBusy("");
    }
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const bounds = mainRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return;
    const move = (ev: PointerEvent) => {
      const ratio = (bounds.right - ev.clientX) / bounds.width;
      const next = Math.min(0.75, Math.max(0.25, ratio));
      editRatioRef.current = next;
      setEditRatio(next);
    };
    const stop = () => {
      localStorage.setItem(EDIT_RATIO_KEY, String(editRatioRef.current));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  const sourceName = pdfPath.split(/[/\\]/).pop() ?? "";

  function jumpToIssue(issue: Issue) {
    if (issue.page) setPage(Math.min(pageCount, Math.max(1, issue.page)));
    if (issue.recordId) {
      const row = window.document.querySelector(`[data-record="${CSS.escape(issue.recordId)}"]`);
      row?.scrollIntoView({ block: "nearest" });
    }
  }

  return (
    <div className="app">
      <header>
        <div className="brand">
          <h1>PDF拆分器</h1>
          <button type="button" className="help-open" aria-label="帮助" title="帮助" onClick={() => setHelpOpen(true)}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <path d="M6.2 6.1a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.7.5-.7 1v.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <circle cx="8" cy="11.6" r="0.7" fill="currentColor" />
            </svg>
          </button>
        </div>
        <div className="source-file" title={pdfPath || undefined}>
          <span>原文件</span>
          <div className="source-file-row">
            <button type="button" className="primary" onClick={() => void choosePdf()}>
              打开 PDF
            </button>
            <strong>{sourceName}</strong>
          </div>
        </div>
        <label className="book-title">
          书籍总名
          <input
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value.replace(/^\s+/, ""))}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            placeholder="用于文件名"
          />
        </label>
      </header>

      <main ref={mainRef} style={{ "--edit": String(editRatio) } as CSSProperties}>
        <PreviewPane
          document={pdfDocument}
          page={page}
          pageCount={pageCount}
          scale={scale}
          reveal={reveal}
          highlight={highlight}
          onPage={(next) => setPage(Math.min(pageCount || 1, Math.max(1, next)))}
          onScale={setScale}
        />
        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整预览区和编辑区宽度"
          onPointerDown={beginResize}
        />
        <aside>
          <div className="editor-scroll" data-records>
            <label className="heading-unit">
              序号样式
              <select value={headingUnit} onChange={(event) => setHeadingUnit(event.target.value)}>
                <option value="">不选择</option>
                {HEADING_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </label>
            <ChapterList
              chapters={sorted}
              files={plan.files}
              page={page}
              pageCount={pageCount}
              onChange={updateChapter}
              onCommit={commitDraft}
              onRemove={(id) => setChapters((current) => current.filter((item) => item.id !== id))}
              onMove={moveChapter}
              onJump={setPage}
              errorIds={errorIds}
              warningIds={warningIds}
              activeId={activeId}
              onActivate={activateRow}
              onPickIndex={pickIndex}
            />
          </div>
          {showChecks && (plan.errors.length > 0 || plan.warnings.length > 0) ? (
            <div className="issues" aria-live="polite">
              {plan.errors.length > 0 ? (
                <div className="issue-group">
                  <p className="issue-label error">不能拆分</p>
                  {plan.errors.map((issue, index) => (
                    <button type="button" key={`e-${issue.recordId ?? ""}-${index}`} className="issue error" onClick={() => jumpToIssue(issue)}>
                      {issue.message}
                    </button>
                  ))}
                </div>
              ) : null}
              {plan.warnings.length > 0 ? (
                <div className="issue-group">
                  <p className="issue-label warning">请确认</p>
                  {plan.warnings.map((issue, index) => (
                    <button type="button" key={`w-${issue.recordId ?? ""}-${index}`} className="issue warning" onClick={() => jumpToIssue(issue)}>
                      {issue.message}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <footer>
            <div className="output">
              <span>拆分至</span>
              <strong title={splitTarget}>{splitTarget}</strong>
            </div>
            {progress ? (
              <p className="progress">
                正在写出 {progress.current}/{progress.total}
                {progress.title ? ` · ${progress.title}` : ""}
              </p>
            ) : null}
            {notice ? <p className="notice">{notice}</p> : null}
            {failure ? <p className="failure">{failure}</p> : null}
            <div className="export-row">
              <button type="button" onClick={() => void chooseOutput()} disabled={!pdfPath}>
                更改目录
              </button>
              <button
                type="button"
                className="primary large"
                disabled={!pdfPath || plan.errors.length > 0 || busy !== ""}
                title={plan.errors.length > 0 ? "还有不能拆分的问题" : plan.warnings.length > 0 ? "有需要确认的问题" : undefined}
                onClick={() => void startSplit()}
              >
                {busy || "开始拆分"}
              </button>
              <button type="button" disabled={!resultDir} onClick={() => void openPath(resultDir)}>
                打开文件夹
              </button>
              <div className="export-row-end">
                <button type="button" onClick={() => void exportRecords()}>
                  导出配置
                </button>
                <button type="button" onClick={() => void importRecords()}>
                  导入配置
                </button>
              </div>
            </div>
          </footer>
        </aside>
      </main>
      <footer className="window-footer">
        <span>Ver {appMeta.version}</span>
        <span aria-hidden="true">|</span>
        <span>400-858-0933</span>
        <span aria-hidden="true">|</span>
        <span>陕西龙脉云信息科技有限公司</span>
      </footer>

      {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} /> : null}

      {closeAsk ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true">
            <h2>确定关闭</h2>
            <p>
              {chapters.some((item) => !isBlankChapter(item))
                ? "关闭前会先把当前拆分记录导出为配置文件，文件名使用书籍总名。"
                : "确定要关闭 PDF拆分器吗？"}
            </p>
            <div className="modal-actions">
              <button type="button" className="primary" onClick={() => void confirmClose()}>
                确定
              </button>
              <button type="button" onClick={() => setCloseAsk(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {renameAsk != null ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true">
            <h2>重命名拆分章节</h2>
            <p>
              书籍总名将改为「{renameAsk || "（空）"}」。确定后，已有章节的文件名预览会改用这个名称。标题预览仍是章节序号和标题。
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setBookTitle(renameAsk);
                  snapshot.current = { ...snapshot.current, bookTitle: renameAsk };
                  setRenameAsk(null);
                  if (closeAfterRename) {
                    setCloseAfterRename(false);
                    setCloseAsk(true);
                  }
                }}
              >
                确定
              </button>
              <button
                type="button"
                onClick={() => {
                  setTitleDraft(bookTitle);
                  setRenameAsk(null);
                  if (closeAfterRename) {
                    setCloseAfterRename(false);
                    setCloseAsk(true);
                  }
                }}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pending ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true">
            <h2>发现上次的标记</h2>
            <p>
              {pending.progress.chapters.length} 条章节，保存于 {pending.progress.savedAt}。要接着用这些标记吗？
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  applyProgress(pending.info, pending.progress);
                  setPending(null);
                }}
              >
                恢复
              </button>
              <button
                type="button"
                onClick={() => {
                  applyFresh(pending.info);
                  setPending(null);
                }}
              >
                重新开始
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingImport ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true">
            <h2>导入拆分记录</h2>
            <p>
              当前表格已有 {chapters.length} 条记录。导入会用文件中的 {pendingImport.chapters.length} 条替换它们。
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  applyImported(pendingImport);
                  setPendingImport(null);
                }}
              >
                替换
              </button>
              <button type="button" onClick={() => setPendingImport(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true">
            <h2>拆分前需要确认</h2>
            <p>下面这些问题不阻止拆分。确认无误后可以继续。</p>
            <ul>
              {plan.warnings.map((issue) => (
                <li key={issue.message}>{issue.message}</li>
              ))}
            </ul>
            <div className="modal-actions">
              <button type="button" className="primary" onClick={() => void startSplit(true)}>
                仍然拆分
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                返回修改
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function textOf(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return "操作没有完成。";
}
