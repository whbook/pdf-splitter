mod naming;
mod pdf_ops;
mod progress;
mod publish;
mod validate;

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use pdf_ops::PdfEngine;
use progress::{book_identity, load_progress, save_progress, ProgressDraft, SavedProgress};
use publish::{publish_outputs, TEMP_DIR_NAME};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use validate::{validate, ChapterRecord, Validation};

struct AppState {
    engine: Mutex<Option<PdfEngine>>,
    open_path: Mutex<Option<PathBuf>>,
    dll_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectResult {
    page_count: u32,
    file_size: u64,
    default_title: String,
    book_id: String,
    parent_dir: String,
    progress: Option<SavedProgress>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitOutcome {
    directory: String,
    files: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitProgress {
    current: usize,
    total: usize,
    title: String,
}

fn with_engine<T>(state: &AppState, task: impl FnOnce(&PdfEngine) -> Result<T, String>) -> Result<T, String> {
    let mut slot = state.engine.lock().unwrap_or_else(|error| error.into_inner());
    if slot.is_none() {
        *slot = Some(PdfEngine::open(&state.dll_dir)?);
    }
    task(slot.as_ref().expect("PDF 组件刚刚完成加载"))
}

fn find_pdfium_dir(app: &AppHandle) -> PathBuf {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.clone());
        candidates.push(dir.join("resources"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.to_path_buf());
            candidates.push(parent.join("resources"));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));
    candidates
        .into_iter()
        .find(|dir| {
            dir.join("pdfium.dll").exists()
                || dir.join("libpdfium.dylib").exists()
                || dir.join("libpdfium.so").exists()
        })
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"))
}

#[tauri::command]
fn inspect_pdf(state: State<AppState>, path: String) -> Result<InspectResult, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("找不到这个 PDF 文件。".into());
    }
    let page_count = with_engine(&state, |engine| engine.page_count(&source))?;
    if page_count == 0 {
        return Err("这份 PDF 没有页面。".into());
    }
    let file_size = fs::metadata(&source).map_err(|error| format!("无法读取文件信息：{error}"))?.len();
    let book_id = book_identity(&source)?;
    let progress = load_progress(&book_id)?;
    let default_title = source
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名".into());
    let parent_dir = source
        .parent()
        .map(|dir| dir.to_string_lossy().to_string())
        .unwrap_or_default();
    *state.open_path.lock().unwrap_or_else(|error| error.into_inner()) = Some(source);
    Ok(InspectResult {
        page_count,
        file_size,
        default_title,
        book_id,
        parent_dir,
        progress,
    })
}

#[tauri::command]
fn read_pdf_range(state: State<AppState>, begin: u64, end: u64) -> Result<tauri::ipc::Response, String> {
    if end < begin {
        return Err("读取范围无效。".into());
    }
    let length = end - begin;
    if length > 2 * 1024 * 1024 {
        return Err("请求的片段过大。".into());
    }
    let path = state
        .open_path
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
        .ok_or("尚未打开 PDF。")?;
    let mut file = File::open(path).map_err(|error| format!("无法读取 PDF：{error}"))?;
    file.seek(SeekFrom::Start(begin)).map_err(|error| format!("无法读取 PDF：{error}"))?;
    let mut buffer = vec![0u8; length as usize];
    let mut filled = 0;
    while filled < buffer.len() {
        let read = file.read(&mut buffer[filled..]).map_err(|error| format!("无法读取 PDF：{error}"))?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    buffer.truncate(filled);
    Ok(tauri::ipc::Response::new(buffer))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let file = Path::new(&path);
    if let Some(parent) = file.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
        }
    }
    fs::write(file, contents).map_err(|error| format!("无法写入文件：{error}"))
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(Path::new(&path)).map_err(|error| format!("无法读取文件：{error}"))
}

#[tauri::command]
fn save_progress_cmd(book_id: String, draft: ProgressDraft) -> Result<SavedProgress, String> {
    save_progress(&book_id, draft)
}

#[tauri::command]
fn preview_split(
    book_title: String,
    output_dir: String,
    page_count: u32,
    records: Vec<ChapterRecord>,
    heading_unit: Option<String>,
) -> Validation {
    validate(
        &book_title,
        &output_dir,
        page_count,
        &records,
        heading_unit.as_deref().unwrap_or(""),
    )
}

#[tauri::command]
fn split_pdf(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    book_title: String,
    output_dir: String,
    records: Vec<ChapterRecord>,
    heading_unit: Option<String>,
) -> Result<SplitOutcome, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("找不到这个 PDF 文件。".into());
    }
    let page_count = with_engine(&state, |engine| engine.page_count(&source))?;
    let plan = validate(
        &book_title,
        &output_dir,
        page_count,
        &records,
        heading_unit.as_deref().unwrap_or(""),
    );
    if !plan.errors.is_empty() {
        return Err(plan.errors.into_iter().map(|issue| issue.message).collect::<Vec<_>>().join("\n"));
    }
    if plan.files.is_empty() {
        return Err("没有可以导出的章节。".into());
    }

    let subdir = Path::new(output_dir.trim()).join(&plan.directory_name);
    let temp = subdir.join(TEMP_DIR_NAME);
    if temp.exists() {
        fs::remove_dir_all(&temp).map_err(|error| format!("无法清理上次留下的临时文件：{error}"))?;
    }
    fs::create_dir_all(&temp).map_err(|error| format!("无法创建临时目录：{error}"))?;

    let jobs: Vec<(PathBuf, u32, u32)> = plan
        .files
        .iter()
        .map(|file| (temp.join(&file.filename), file.start_page, file.end_page))
        .collect();
    let titles: Vec<String> = records_titles(&records, &plan.files);
    let total = jobs.len();

    let produced = jobs
        .iter()
        .map(|(dest, _, _)| {
            (
                dest.file_name().unwrap_or_default().to_string_lossy().to_string(),
                dest.clone(),
            )
        })
        .collect::<Vec<_>>();

    let write_result = (|| -> Result<SplitOutcome, String> {
        {
            let slot = state.engine.lock().unwrap_or_else(|error| error.into_inner());
            let engine = slot.as_ref().ok_or_else(|| "PDF 组件尚未加载。".to_string())?;
            for (index, job) in jobs.iter().enumerate() {
                let _ = app.emit(
                    "split-progress",
                    SplitProgress {
                        current: index + 1,
                        total,
                        title: titles.get(index).cloned().unwrap_or_default(),
                    },
                );
                engine.write_ranges(&source, std::slice::from_ref(job))?;
            }
        }
        let book_id = book_identity(&source)?;
        publish_outputs(&subdir, &book_id, book_title.trim(), &produced)?;
        Ok(SplitOutcome {
            directory: subdir.to_string_lossy().to_string(),
            files: plan.files.iter().map(|file| file.filename.clone()).collect(),
        })
    })();

    if write_result.is_err() {
        let _ = fs::remove_dir_all(&temp);
    } else {
        let _ = fs::remove_dir_all(&temp);
    }
    write_result
}

fn records_titles(records: &[ChapterRecord], files: &[validate::PlannedFile]) -> Vec<String> {
    files
        .iter()
        .map(|file| {
            records
                .iter()
                .find(|record| record.id == file.record_id)
                .map(|record| record.title.trim().to_string())
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| file.filename.clone())
        })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(AppState {
                engine: Mutex::new(None),
                open_path: Mutex::new(None),
                dll_dir: find_pdfium_dir(app.handle()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            inspect_pdf,
            read_pdf_range,
            write_text_file,
            read_text_file,
            save_progress_cmd,
            preview_split,
            split_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
