use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use chrono::Local;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::validate::ChapterRecord;

const SAMPLE: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedProgress {
    pub book_title: String,
    pub output_dir: String,
    #[serde(default)]
    pub heading_unit: String,
    pub chapters: Vec<ChapterRecord>,
    pub last_page: u32,
    pub saved_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressDraft {
    pub book_title: String,
    pub output_dir: String,
    #[serde(default)]
    pub heading_unit: String,
    pub chapters: Vec<ChapterRecord>,
    pub last_page: u32,
}

pub fn progress_root() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("无法确定进度保存位置。")?;
    let dir = base.join("PDF拆分器").join("progress");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建进度目录：{error}"))?;
    Ok(dir)
}

pub fn book_identity(path: &Path) -> Result<String, String> {
    let file_size = fs::metadata(path).map_err(|error| format!("无法读取文件信息：{error}"))?.len();
    let mut file = File::open(path).map_err(|error| format!("无法打开文件：{error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(file_size.to_le_bytes());
    if file_size <= SAMPLE {
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer).map_err(|error| format!("无法读取文件：{error}"))?;
        hasher.update(&buffer);
    } else {
        hash_range(&mut file, &mut hasher, 0, SAMPLE)?;
        hash_range(&mut file, &mut hasher, file_size - SAMPLE, SAMPLE)?;
    }
    Ok(to_hex(&hasher.finalize()))
}

fn hash_range(file: &mut File, hasher: &mut Sha256, start: u64, length: u64) -> Result<(), String> {
    file.seek(SeekFrom::Start(start)).map_err(|error| format!("无法读取文件：{error}"))?;
    let mut remaining = length;
    let mut buffer = vec![0u8; 64 * 1024];
    while remaining > 0 {
        let want = remaining.min(buffer.len() as u64) as usize;
        let read = file.read(&mut buffer[..want]).map_err(|error| format!("无法读取文件：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        remaining -= read as u64;
    }
    Ok(())
}

pub fn load_progress(book_id: &str) -> Result<Option<SavedProgress>, String> {
    load_progress_from(&progress_root()?, book_id)
}

pub fn save_progress(book_id: &str, draft: ProgressDraft) -> Result<SavedProgress, String> {
    save_progress_to(&progress_root()?, book_id, draft)
}

pub fn load_progress_from(dir: &Path, book_id: &str) -> Result<Option<SavedProgress>, String> {
    ensure_book_id(book_id)?;
    let path = dir.join(format!("{book_id}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|error| format!("无法读取标记进度：{error}"))?;
    serde_json::from_str(&text).map(Some).map_err(|error| format!("标记进度已损坏：{error}"))
}

pub fn save_progress_to(dir: &Path, book_id: &str, draft: ProgressDraft) -> Result<SavedProgress, String> {
    ensure_book_id(book_id)?;
    fs::create_dir_all(dir).map_err(|error| format!("无法创建进度目录：{error}"))?;
    let saved = SavedProgress {
        book_title: draft.book_title,
        output_dir: draft.output_dir,
        heading_unit: crate::naming::normalize_unit(&draft.heading_unit).to_string(),
        chapters: draft.chapters,
        last_page: draft.last_page,
        saved_at: Local::now().format("%Y-%m-%d %H:%M").to_string(),
    };
    let path = dir.join(format!("{book_id}.json"));
    let temporary = dir.join(format!("{book_id}.json.tmp"));
    {
        let mut file = File::create(&temporary).map_err(|error| format!("无法保存标记进度：{error}"))?;
        let text = serde_json::to_string_pretty(&saved).map_err(|error| format!("无法保存标记进度：{error}"))?;
        file.write_all(text.as_bytes()).map_err(|error| format!("无法保存标记进度：{error}"))?;
    }
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("无法保存标记进度：{error}"))?;
    }
    fs::rename(&temporary, &path).map_err(|error| format!("无法保存标记进度：{error}"))?;
    Ok(saved)
}

fn ensure_book_id(book_id: &str) -> Result<(), String> {
    if book_id.len() == 64 && book_id.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("进度标识无效。".into())
    }
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(HEX[(byte >> 4) as usize] as char);
        text.push(HEX[(byte & 0xf) as usize] as char);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_changes_when_the_end_of_a_large_file_changes() {
        let dir = std::env::temp_dir().join(format!("pdf-splitter-id-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.bin");
        fs::write(&path, vec![1u8; (SAMPLE as usize) + 64]).unwrap();
        let first = book_identity(&path).unwrap();
        let mut file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::End(-1)).unwrap();
        file.write_all(&[9]).unwrap();
        let second = book_identity(&path).unwrap();
        assert_ne!(first, second);
        assert_eq!(book_identity(&path).unwrap(), second);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn progress_round_trip_uses_a_temporary_file() {
        let dir = std::env::temp_dir().join(format!("pdf-splitter-progress-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let book_id = "a".repeat(64);
        let saved = save_progress_to(
            &dir,
            &book_id,
            ProgressDraft {
                book_title: "三国志".into(),
                output_dir: "D:\\书".into(),
                heading_unit: "章".into(),
                chapters: Vec::new(),
                last_page: 4,
            },
        )
        .unwrap();
        let loaded = load_progress_from(&dir, &book_id).unwrap().unwrap();
        assert_eq!(loaded, saved);
        assert!(!dir.join(format!("{book_id}.json.tmp")).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
