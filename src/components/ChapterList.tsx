import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ChapterRecord, PlannedFile } from "../lib/types";
import { isBlankChapter } from "../lib/validate";

const COLUMN_WIDTH_KEY = "pdf-splitter.columnWidths";
const DEFAULT_WIDTHS = [52, 58, 58, 240, 96, 148, 168];
const MIN_WIDTHS = [40, 44, 44, 88, 64, 80, 132];
const HEADERS = ["序号", "起", "止", "标题", "标题预览", "文件名预览", "操作"];

function loadColumnWidths(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(COLUMN_WIDTH_KEY) ?? "");
    if (!Array.isArray(raw) || raw.length !== DEFAULT_WIDTHS.length) return DEFAULT_WIDTHS;
    return raw.map((value, index) => {
      const width = Number(value);
      return Number.isFinite(width) ? Math.max(MIN_WIDTHS[index], width) : DEFAULT_WIDTHS[index];
    });
  } catch {
    return DEFAULT_WIDTHS;
  }
}

type Props = {
  chapters: ChapterRecord[];
  files: PlannedFile[];
  page: number;
  pageCount: number;
  onChange: (id: string, patch: Partial<ChapterRecord>) => void;
  onCommit: (record: ChapterRecord) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onJump: (page: number) => void;
  errorIds: ReadonlySet<string>;
  warningIds: ReadonlySet<string>;
  activeId: string | null;
  onActivate: (id: string) => void;
  onPickIndex: (id: string) => void;
};

function blankChapter(): ChapterRecord {
  return { id: crypto.randomUUID(), startPage: null, endPage: null, title: "", manualOrder: 0 };
}

export function ChapterList({
  chapters,
  files,
  page,
  pageCount,
  onChange,
  onCommit,
  onRemove,
  onMove,
  onJump,
  errorIds,
  warningIds,
  activeId,
  onActivate,
  onPickIndex,
}: Props) {
  const [draft, setDraft] = useState(blankChapter);
  const [widths, setWidths] = useState(loadColumnWidths);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  function beginColumnResize(index: number, event: ReactPointerEvent<HTMLSpanElement>) {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const start = widthsRef.current[index];
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== event.pointerId) return;
      const next = Math.max(MIN_WIDTHS[index], Math.round(start + ev.clientX - startX));
      setWidths((current) => {
        const copy = current.slice();
        copy[index] = next;
        widthsRef.current = copy;
        return copy;
      });
    };
    const stop = (ev: PointerEvent) => {
      if (ev.pointerId !== event.pointerId) return;
      localStorage.setItem(COLUMN_WIDTH_KEY, JSON.stringify(widthsRef.current));
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
  }

  function changeRow(chapter: ChapterRecord, patch: Partial<ChapterRecord>, isDraft: boolean) {
    if (!isDraft) {
      onChange(chapter.id, patch);
      return;
    }
    const next = { ...chapter, ...patch };
    if (isBlankChapter(next)) {
      setDraft(next);
      return;
    }
    onCommit(next);
    setDraft(blankChapter());
  }

  const rows = [...chapters, draft];

  return (
    <div className="ledger">
      <div className="ledger-head">
        <h2>章节 {chapters.length}</h2>
      </div>
      <table className="chapter-grid">
        <colgroup>
          {widths.map((width, index) => (
            <col key={HEADERS[index]} style={{ width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {HEADERS.map((label, index) => (
              <th key={label}>
                <span className="th-label">{label}</span>
                {index < HEADERS.length - 1 ? (
                  <span
                    className="col-resize"
                    title="拖动调整列宽"
                    onPointerDown={(event) => beginColumnResize(index, event)}
                  />
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((chapter, index) => {
            const isDraft = chapter.id === draft.id;
            const file = files.find((item) => item.recordId === chapter.id);
            const previous = rows[index - 1];
            const next = rows[index + 1];
            const sameAsPrevious = !isDraft && previous && !isDraftRow(previous, draft.id) && sameRange(previous, chapter);
            const sameAsNext = next && !isDraftRow(next, draft.id) && sameRange(chapter, next);
            const current = chapter.startPage === page || chapter.endPage === page;
            return (
              <tr
                key={chapter.id}
                data-record={chapter.id}
                className={[
                  current ? "current" : "",
                  chapter.id === activeId ? "picked" : "",
                  isDraft ? "draft" : "",
                  errorIds.has(chapter.id) ? "rejected" : warningIds.has(chapter.id) ? "caution" : "",
                ].filter(Boolean).join(" ")}
                onFocus={() => onActivate(chapter.id)}
              >
                <td className="cell-index">
                  <button
                    type="button"
                    className="index-hit"
                    title={chapter.startPage ? `定位到第 ${chapter.startPage} 页` : "这一行还没有起始页"}
                    onClick={() => onPickIndex(chapter.id)}
                  >
                    {file ? file.sequence : "—"}
                  </button>
                </td>
                <td>
                  <input
                    aria-label="起始页"
                    value={chapter.startPage ?? ""}
                    inputMode="numeric"
                    maxLength={6}
                    placeholder={isDraft ? "起" : undefined}
                    onChange={(event) => changeRow(chapter, { startPage: parsePage(event.target.value) }, isDraft)}
                  />
                </td>
                <td>
                  <input
                    aria-label="结束页"
                    value={chapter.endPage ?? ""}
                    inputMode="numeric"
                    maxLength={6}
                    placeholder={isDraft ? "止" : undefined}
                    onChange={(event) => changeRow(chapter, { endPage: parsePage(event.target.value) }, isDraft)}
                  />
                </td>
                <td>
                  <input
                    aria-label="标题"
                    value={chapter.title}
                    placeholder={isDraft ? "在此输入新的一章" : "输入标题"}
                    onChange={(event) => changeRow(chapter, { title: event.target.value }, isDraft)}
                  />
                </td>
                <td className="cell-preview" title={file?.label ?? ""}>
                  {file?.label || "—"}
                </td>
                <td className="cell-file" title={file?.filename ?? ""}>
                  {file?.filename || "—"}
                </td>
                <td className="cell-ops">
                  <button type="button" title="结束于当前页" onClick={() => changeRow(chapter, { endPage: page }, isDraft)} disabled={pageCount === 0}>
                    此页
                  </button>
                  <button type="button" title="结束页设为末页" onClick={() => changeRow(chapter, { endPage: pageCount }, isDraft)} disabled={pageCount === 0}>
                    末页
                  </button>
                  <button type="button" title="看起始页" onClick={() => chapter.startPage && onJump(chapter.startPage)} disabled={!chapter.startPage}>
                    看
                  </button>
                  <button type="button" title="上移" onClick={() => onMove(chapter.id, -1)} disabled={isDraft || !sameAsPrevious}>
                    上
                  </button>
                  <button type="button" title="下移" onClick={() => onMove(chapter.id, 1)} disabled={isDraft || !sameAsNext}>
                    下
                  </button>
                  {isDraft ? null : (
                    <button type="button" className="danger" title="删除" onClick={() => onRemove(chapter.id)}>
                      删
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function parsePage(value: string): number | null {
  if (!/^\d{1,6}$/.test(value)) return null;
  return Number(value);
}

function sameRange(left: ChapterRecord, right: ChapterRecord): boolean {
  return left.startPage != null && left.startPage === right.startPage && left.endPage === right.endPage;
}

function isDraftRow(chapter: ChapterRecord, draftId: string): boolean {
  return chapter.id === draftId;
}
