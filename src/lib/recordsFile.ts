import type { ChapterRecord } from "./types";
import { isBlankChapter, normalizeUnit } from "./validate";

export type SplitRecordFile = {
  bookTitle: string;
  headingUnit: string;
  chapters: Array<{
    startPage: number | null;
    endPage: number | null;
    title: string;
    manualOrder: number;
  }>;
};

export function buildRecordFile(bookTitle: string, headingUnit: string, chapters: ChapterRecord[]): SplitRecordFile {
  return {
    bookTitle,
    headingUnit: normalizeUnit(headingUnit),
    chapters: chapters.filter((chapter) => !isBlankChapter(chapter)).map((chapter) => ({
      startPage: chapter.startPage,
      endPage: chapter.endPage,
      title: chapter.title,
      manualOrder: chapter.manualOrder,
    })),
  };
}

export function parseRecordFile(text: string): { bookTitle: string; headingUnit: string; chapters: ChapterRecord[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("这个文件不是有效的 JSON。");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("这个 JSON 里没有拆分记录。");
  }
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.chapters)) {
    throw new Error("这个 JSON 里没有拆分记录。");
  }
  const chapters = record.chapters.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`第 ${index + 1} 条记录无法读取。`);
    }
    const row = item as Record<string, unknown>;
    const chapter: ChapterRecord = {
      id: crypto.randomUUID(),
      startPage: pageValue(row.startPage, index),
      endPage: pageValue(row.endPage, index),
      title: typeof row.title === "string" ? row.title : "",
      manualOrder: typeof row.manualOrder === "number" && Number.isInteger(row.manualOrder) ? row.manualOrder : index,
    };
    return isBlankChapter(chapter) ? [] : [chapter];
  });
  if (chapters.length === 0) {
    throw new Error("文件里没有可导入的拆分记录。");
  }
  return {
    bookTitle: typeof record.bookTitle === "string" ? record.bookTitle : "",
    headingUnit: normalizeUnit(typeof record.headingUnit === "string" ? record.headingUnit : ""),
    chapters,
  };
}

function pageValue(value: unknown, index: number): number | null {
  if (value == null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`第 ${index + 1} 条记录的页码必须是整数。`);
  }
  return value;
}
