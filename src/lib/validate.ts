// 与 src-tauri/src/naming.rs、validate.rs 保持同一套规则。导出时以 Rust 的结果为准。

import type { ChapterRecord, Issue, PlannedFile, Validation } from "./types";

export const HEADING_UNITS = ["卷", "篇", "章", "节", "回"] as const;

const MAX_TITLE_CHARS = 80;
const MAX_PATH_CHARS = 240;
const SPLIT_DIR_SUFFIX = "-章节拆分";
const RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

export function sanitizeComponent(input: string): string {
  let cleaned = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127 || "\\/:*?\"<>|".includes(ch)) continue;
    cleaned += ch;
  }
  let text = cleaned.trim();
  while (text.endsWith(".") || text.endsWith(" ")) text = text.slice(0, -1);
  text = text.trim();
  if (!text) return "";
  const stem = text.split(".")[0] ?? text;
  if (RESERVED.has(text.toUpperCase()) || RESERVED.has(stem.toUpperCase())) text += "_";
  return text;
}

export function splitDirectoryName(bookTitle: string): string {
  return `${bookTitle}${SPLIT_DIR_SUFFIX}`;
}

export function joinPath(dir: string, ...parts: string[]): string {
  const slash = dir.includes("\\") ? "\\" : "/";
  let path = dir.replace(/[\\/]+$/, "");
  for (const part of parts) path += slash + part.replace(/^[\\/]+/, "");
  return path;
}

export function sortRecords(records: ChapterRecord[]): ChapterRecord[] {
  return [...records].sort((a, b) => {
    const start = (a.startPage ?? Number.MAX_SAFE_INTEGER) - (b.startPage ?? Number.MAX_SAFE_INTEGER);
    if (start !== 0) return start;
    const end = (a.endPage ?? Number.MAX_SAFE_INTEGER) - (b.endPage ?? Number.MAX_SAFE_INTEGER);
    if (end !== 0) return end;
    return a.manualOrder - b.manualOrder;
  });
}

export function isBlankChapter(record: ChapterRecord): boolean {
  return record.startPage == null && record.endPage == null && record.title.trim() === "";
}

function displayTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed || "未命名章节";
}

function formatSegments(segments: Array<[number, number]>): string {
  return segments
    .map(([start, end]) => (start === end ? `第 ${start} 页` : `第 ${start}–${end} 页`))
    .join("、");
}

export function normalizeUnit(unit: string): string {
  const trimmed = unit.trim();
  return (HEADING_UNITS as readonly string[]).includes(trimmed) ? trimmed : "";
}

function paddedSequence(sequence: number, total: number): string {
  return String(sequence).padStart(total >= 100 ? 3 : 2, "0");
}

function titlePreview(unit: string, sequence: number, total: number, userTitle: string): string {
  if (!unit) return `${paddedSequence(sequence, total)}-${userTitle}`;
  return userTitle ? `第${sequence}${unit}-${userTitle}` : `第${sequence}${unit}`;
}

export function validate(
  bookTitle: string,
  outputDir: string,
  pageCount: number,
  records: ChapterRecord[],
  headingUnit = "",
): Validation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const book = sanitizeComponent(bookTitle);
  const directoryName = book ? splitDirectoryName(book) : "";

  if (!bookTitle.trim() || !book) {
    errors.push({
      message: "书籍总名无效。请输入名称，不要只使用 \\ / : * ? \" < > | 这些字符。",
      recordId: null,
      page: null,
    });
  }
  if (!outputDir.trim()) {
    errors.push({ message: "请选择输出目录。", recordId: null, page: null });
  }
  const meaningful = records.filter((record) => !isBlankChapter(record));
  if (meaningful.length === 0) {
    errors.push({ message: "请至少添加一个章节。", recordId: null, page: null });
  }

  const unit = normalizeUnit(headingUnit);
  const sorted = sortRecords(meaningful);
  const usable: ChapterRecord[] = [];

  for (const record of sorted) {
    const label = displayTitle(record.title);
    if (record.startPage == null) {
      errors.push({ message: `「${label}」还没有填写起始页。`, recordId: record.id, page: null });
    } else if (record.startPage < 1 || record.startPage > pageCount) {
      errors.push({
        message: `「${label}」的起始页 ${record.startPage} 不在 1–${pageCount} 之内。`,
        recordId: record.id,
        page: record.startPage,
      });
    }
    if (record.endPage == null) {
      errors.push({ message: `「${label}」还没有填写结束页。`, recordId: record.id, page: null });
    } else if (record.endPage < 1 || record.endPage > pageCount) {
      errors.push({
        message: `「${label}」的结束页 ${record.endPage} 不在 1–${pageCount} 之内。`,
        recordId: record.id,
        page: record.endPage,
      });
    }
    if (
      record.startPage != null &&
      record.endPage != null &&
      record.startPage > record.endPage
    ) {
      errors.push({
        message: `「${label}」的起始页 ${record.startPage} 大于结束页 ${record.endPage}。`,
        recordId: record.id,
        page: record.startPage,
      });
    } else if (
      record.startPage != null &&
      record.endPage != null &&
      record.startPage >= 1 &&
      record.endPage >= 1 &&
      record.startPage <= pageCount &&
      record.endPage <= pageCount
    ) {
      usable.push(record);
    }
    if (!unit && !sanitizeComponent(record.title)) {
      errors.push({
        message: `「${label}」没有可用的章节标题。`,
        recordId: record.id,
        page: record.startPage,
      });
    }
  }

  if (pageCount > 0) {
    const covered = Array<boolean>(pageCount).fill(false);
    for (const record of usable) {
      for (let page = record.startPage!; page <= record.endPage!; page += 1) covered[page - 1] = true;
    }
    const missing: Array<[number, number]> = [];
    let index = 0;
    while (index < covered.length) {
      if (covered[index]) {
        index += 1;
        continue;
      }
      const start = index;
      while (index < covered.length && !covered[index]) index += 1;
      missing.push([start + 1, index]);
    }
    if (missing.length > 0) {
      errors.push({
        message: `${formatSegments(missing)}没有归入任何章节。`,
        recordId: null,
        page: missing[0][0],
      });
    }
  }

  rejectCoveringEarlier(usable, errors);
  warnCrowdedPages(usable, warnings);

  for (let index = 0; index < usable.length; index += 1) {
    const record = usable[index];
    const seen = usable.slice(0, index).some(
      (other) =>
        other.startPage === record.startPage &&
        other.endPage === record.endPage &&
        other.title.trim() === record.title.trim(),
    );
    const alreadyBlocked = usable
      .slice(0, index)
      .some((other) => other.endPage != null && record.startPage != null && other.endPage > record.startPage);
    if (seen && !alreadyBlocked) {
      warnings.push({
        message: `「${displayTitle(record.title)}」（${formatSegments([[record.startPage!, record.endPage!]])}）添加了多次。`,
        recordId: record.id,
        page: record.startPage,
      });
    }
  }

  const files: PlannedFile[] = [];
  if (book && outputDir.trim()) {
    const dir = joinPath(outputDir.trim(), directoryName);
    const exportable = usable.filter((record) => unit || sanitizeComponent(record.title));
    const total = exportable.length;
    const used: Array<[string, string]> = [];
    for (const record of exportable) {
      const sequence = files.length + 1;
      const sanitized = sanitizeComponent(record.title);
      let userTitle = [...sanitized].slice(0, MAX_TITLE_CHARS).join("");
      let label = titlePreview(unit, sequence, total, userTitle);
      let filename = `${book}-${label}.pdf`;
      while ([...joinPath(dir, filename)].length > MAX_PATH_CHARS) {
        const chars = [...userTitle];
        if (chars.length === 0 || (!unit && chars.length <= 1)) {
          errors.push({
            message: "书籍总名或输出目录太长，完整路径放不下文件名。请缩短书籍总名，或换一个更浅的输出目录。",
            recordId: record.id,
            page: record.startPage,
          });
          userTitle = "";
          break;
        }
        userTitle = chars.slice(0, -1).join("");
        label = titlePreview(unit, sequence, total, userTitle);
        filename = `${book}-${label}.pdf`;
      }
      if ([...joinPath(dir, filename)].length > MAX_PATH_CHARS) continue;
      if (!unit && !userTitle) continue;
      const previous = used.find(([name]) => name === filename);
      if (previous) {
        errors.push({
          message: `整理后的文件名重复：${filename}。请修改章节标题。`,
          recordId: previous[1],
          page: null,
        });
        errors.push({
          message: `整理后的文件名重复：${filename}。请修改章节标题。`,
          recordId: record.id,
          page: null,
        });
      }
      used.push([filename, record.id]);
      files.push({
        recordId: record.id,
        sequence,
        label,
        filename,
        startPage: record.startPage!,
        endPage: record.endPage!,
      });
    }
  }

  return { errors, warnings, files, directoryName };
}

function rejectCoveringEarlier(records: ChapterRecord[], errors: Issue[]) {
  for (let index = 0; index < records.length - 1; index += 1) {
    const previous = records[index];
    const next = records[index + 1];
    if (next.startPage! >= previous.endPage!) continue;
    errors.push({
      message: `「${displayTitle(next.title)}」（${formatSegments([[next.startPage!, next.endPage!]])}）从第 ${next.startPage} 页开始，盖住了前面的「${displayTitle(previous.title)}」（${formatSegments([[previous.startPage!, previous.endPage!]])}）。后一条最多只能从前一条的结束页第 ${previous.endPage} 页开始。`,
      recordId: next.id,
      page: next.startPage,
    });
  }
}

function warnCrowdedPages(records: ChapterRecord[], warnings: Issue[]) {
  const owners = new Map<number, ChapterRecord[]>();
  for (const record of records) {
    for (let page = record.startPage!; page <= record.endPage!; page += 1) {
      const list = owners.get(page);
      if (list) list.push(record);
      else owners.set(page, [record]);
    }
  }
  const crowded = [...owners.entries()].filter(([, list]) => list.length >= 3).sort((a, b) => a[0] - b[0]);
  let index = 0;
  while (index < crowded.length) {
    const [startPage, group] = crowded[index];
    const key = group.map((record) => record.id).join("\0");
    let endPage = startPage;
    let cursor = index + 1;
    while (cursor < crowded.length) {
      const [page, list] = crowded[cursor];
      if (page !== endPage + 1 || list.map((record) => record.id).join("\0") !== key) break;
      endPage = page;
      cursor += 1;
    }
    const names = group.map((record) => `「${displayTitle(record.title)}」`).join("");
    warnings.push({
      message: `${formatSegments([[startPage, endPage]])}同时属于 ${group.length} 个章节：${names}。一页通常最多同时属于两个章节，请确认是不是标重了。`,
      recordId: group[group.length - 1]?.id ?? null,
      page: startPage,
    });
    index = cursor;
  }
}
