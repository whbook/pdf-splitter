//! 把临时目录里的新文件替换进输出目录。失败时由调用方删除临时目录。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const MANIFEST_NAME: &str = ".pdf拆分器.json";
pub const TEMP_DIR_NAME: &str = ".pdf拆分器-tmp";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    book_id: String,
    book_title: String,
    files: Vec<String>,
}

pub fn publish_outputs(
    subdir: &Path,
    book_id: &str,
    book_title: &str,
    produced: &[(String, PathBuf)],
) -> Result<(), String> {
    fs::create_dir_all(subdir).map_err(|error| format!("无法创建输出目录：{error}"))?;
    let manifest_path = subdir.join(MANIFEST_NAME);
    let previous = read_manifest(&manifest_path)?;
    let new_names: Vec<String> = produced.iter().map(|(name, _)| name.clone()).collect();

    let mut targets = Vec::new();
    for name in &new_names {
        let path = subdir.join(name);
        if path.exists() {
            targets.push(path);
        }
    }
    if let Some(previous) = &previous {
        for name in &previous.files {
            if !new_names.iter().any(|item| item == name) {
                let path = subdir.join(name);
                if path.exists() {
                    targets.push(path);
                }
            }
        }
    }
    for path in &targets {
        ensure_replaceable(path)?;
    }

    for (name, source) in produced {
        replace_with(source, &subdir.join(name))?;
    }

    if let Some(previous) = &previous {
        for name in &previous.files {
            if !new_names.iter().any(|item| item == name) {
                let path = subdir.join(name);
                if path.exists() {
                    fs::remove_file(&path).map_err(|error| {
                        format!(
                            "新文件已经写入，但无法删除旧文件 {}。请关闭占用它的程序后再次拆分。（{error}）",
                            path.file_name().unwrap_or_default().to_string_lossy()
                        )
                    })?;
                }
            }
        }
    }

    write_manifest(
        &manifest_path,
        &Manifest {
            book_id: book_id.to_string(),
            book_title: book_title.to_string(),
            files: new_names,
        },
    )
}

fn ensure_replaceable(path: &Path) -> Result<(), String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map(|_| ())
        .map_err(|_| {
            format!(
                "文件被占用，无法替换：{}。请关闭正在打开它的程序后重试。本次未改动已有文件。",
                path.file_name().unwrap_or_default().to_string_lossy()
            )
        })
}

fn replace_with(source: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        let backup = backup_path(dest);
        if backup.exists() {
            let _ = fs::remove_file(&backup);
        }
        fs::rename(dest, &backup).map_err(|error| {
            format!("无法移开旧文件 {}：{error}", dest.file_name().unwrap_or_default().to_string_lossy())
        })?;
        if let Err(error) = fs::rename(source, dest) {
            let _ = fs::rename(&backup, dest);
            return Err(format!(
                "无法写入 {}：{error}",
                dest.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
        let _ = fs::remove_file(&backup);
    } else if let Err(error) = fs::rename(source, dest) {
        return Err(format!(
            "无法写入 {}：{error}",
            dest.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    Ok(())
}

fn backup_path(path: &Path) -> PathBuf {
    let mut backup = path.as_os_str().to_owned();
    backup.push(".bak");
    PathBuf::from(backup)
}

fn read_manifest(path: &Path) -> Result<Option<Manifest>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|error| format!("无法读取拆分清单：{error}"))?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&text).map(Some).map_err(|error| format!("拆分清单已损坏：{error}"))
}

fn write_manifest(path: &Path, manifest: &Manifest) -> Result<(), String> {
    let text = serde_json::to_string_pretty(manifest).map_err(|error| format!("无法生成拆分清单：{error}"))?;
    let temporary = path.with_extension("json.tmp");
    {
        let mut file = File::create(&temporary).map_err(|error| format!("无法写入拆分清单：{error}"))?;
        file.write_all(text.as_bytes()).map_err(|error| format!("无法写入拆分清单：{error}"))?;
    }
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("无法更新拆分清单：{error}"))?;
    }
    fs::rename(&temporary, path).map_err(|error| format!("无法更新拆分清单：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use std::os::windows::fs::OpenOptionsExt;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pdf-splitter-publish-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, text).unwrap();
    }

    #[test]
    fn replaces_previous_split_and_keeps_unrelated_files() {
        let root = scratch();
        let subdir = root.join("书-章节拆分");
        write(&subdir.join("书-1-旧章.pdf"), "old-1");
        write(&subdir.join("书-2-删掉.pdf"), "old-2");
        write(&subdir.join("我的笔记.txt"), "keep");
        write_manifest(
            &subdir.join(MANIFEST_NAME),
            &Manifest {
                book_id: "book".into(),
                book_title: "书".into(),
                files: vec!["书-1-旧章.pdf".into(), "书-2-删掉.pdf".into()],
            },
        )
        .unwrap();

        let temp = subdir.join(TEMP_DIR_NAME);
        write(&temp.join("书-1-旧章.pdf"), "new-1");
        write(&temp.join("书-2-新章.pdf"), "new-2");
        publish_outputs(
            &subdir,
            "book",
            "书",
            &[
                ("书-1-旧章.pdf".into(), temp.join("书-1-旧章.pdf")),
                ("书-2-新章.pdf".into(), temp.join("书-2-新章.pdf")),
            ],
        )
        .unwrap();

        assert_eq!(fs::read_to_string(subdir.join("书-1-旧章.pdf")).unwrap(), "new-1");
        assert_eq!(fs::read_to_string(subdir.join("书-2-新章.pdf")).unwrap(), "new-2");
        assert!(!subdir.join("书-2-删掉.pdf").exists());
        assert_eq!(fs::read_to_string(subdir.join("我的笔记.txt")).unwrap(), "keep");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn leaves_existing_files_untouched_when_one_is_locked() {
        let root = scratch();
        let subdir = root.join("书-章节拆分");
        let old = subdir.join("书-1-旧章.pdf");
        write(&old, "old");
        write_manifest(
            &subdir.join(MANIFEST_NAME),
            &Manifest {
                book_id: "book".into(),
                book_title: "书".into(),
                files: vec!["书-1-旧章.pdf".into()],
            },
        )
        .unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&old)
            .unwrap();
        let temp = subdir.join(TEMP_DIR_NAME);
        write(&temp.join("书-1-旧章.pdf"), "new");

        let error = publish_outputs(
            &subdir,
            "book",
            "书",
            &[("书-1-旧章.pdf".into(), temp.join("书-1-旧章.pdf"))],
        )
        .unwrap_err();
        drop(lock);

        assert!(error.contains("被占用"));
        assert_eq!(fs::read_to_string(&old).unwrap(), "old");
        assert!(temp.join("书-1-旧章.pdf").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
