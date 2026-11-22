export type ChapterRecord = {
  id: string;
  startPage: number | null;
  endPage: number | null;
  title: string;
  manualOrder: number;
};

export type Issue = {
  message: string;
  recordId?: string | null;
  page?: number | null;
};

export type PlannedFile = {
  recordId: string;
  sequence: number;
  label: string;
  filename: string;
  startPage: number;
  endPage: number;
};

export type Validation = {
  errors: Issue[];
  warnings: Issue[];
  files: PlannedFile[];
  directoryName: string;
};

export type SavedProgress = {
  bookTitle: string;
  outputDir: string;
  headingUnit?: string;
  chapters: ChapterRecord[];
  lastPage: number;
  savedAt: string;
};

export type InspectResult = {
  pageCount: number;
  fileSize: number;
  defaultTitle: string;
  bookId: string;
  parentDir: string;
  progress: SavedProgress | null;
};
