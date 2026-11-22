use std::path::{Path, PathBuf};

use pdfium_render::prelude::*;

pub struct PdfEngine {
    pdfium: Pdfium,
}

impl PdfEngine {
    pub fn open(dll_dir: &Path) -> Result<Self, String> {
        let library = Pdfium::pdfium_platform_library_name_at_path(dll_dir);
        if !library.exists() {
            return Err(format!("找不到 pdfium 库：{}", library.display()));
        }
        let bindings = Pdfium::bind_to_library(&library).map_err(explain_pdfium)?;
        Ok(Self {
            pdfium: Pdfium::new(bindings),
        })
    }

    pub fn page_count(&self, path: &Path) -> Result<u32, String> {
        let document = self.pdfium.load_pdf_from_file(path, None).map_err(explain_pdfium)?;
        let count = document.pages().len();
        if count < 0 {
            return Err("无法读取页数。".into());
        }
        Ok(count as u32)
    }

    pub fn write_ranges(&self, source_path: &Path, jobs: &[(PathBuf, u32, u32)]) -> Result<(), String> {
        let source = self.pdfium.load_pdf_from_file(source_path, None).map_err(explain_pdfium)?;
        for (dest, start, end) in jobs {
            let mut document = self.pdfium.create_new_pdf().map_err(explain_pdfium)?;
            document
                .pages_mut()
                .copy_pages_from_document(&source, &format!("{start}-{end}"), 0)
                .map_err(|error| format!("复制第 {start}–{end} 页失败：{}", explain_pdfium(error)))?;
            document.save_to_file(dest).map_err(|error| {
                format!(
                    "写入 {} 失败：{}",
                    dest.file_name().unwrap_or_default().to_string_lossy(),
                    explain_pdfium(error)
                )
            })?;
        }
        Ok(())
    }
}

pub fn explain_pdfium(error: PdfiumError) -> String {
    match error {
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError)
        | PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::SecurityError) => {
            "这份 PDF 有密码保护，目前打不开。".into()
        }
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::FormatError) => {
            "无法读取这份 PDF，文件可能已损坏。".into()
        }
        PdfiumError::IoError(error) => format!("无法读取文件：{error}"),
        PdfiumError::LoadLibraryError(error) => format!("无法加载 PDF 组件：{error}"),
        other => format!("无法处理这份 PDF：{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn splits_a_generated_pdf_by_inclusive_ranges() {
        let dll_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let engine = PdfEngine::open(&dll_dir).expect("pdfium.dll 应当随项目提供");
        let root = std::env::temp_dir().join(format!("pdf-splitter-pdf-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let source_path = root.join("source.pdf");
        {
            let mut source = engine.pdfium.create_new_pdf().unwrap();
            for _ in 0..4 {
                drop(
                    source
                        .pages_mut()
                        .create_page_at_end(PdfPagePaperSize::Portrait(PdfPagePaperStandardSize::A4))
                        .unwrap(),
                );
            }
            source.save_to_file(&source_path).unwrap();
        }
        assert_eq!(engine.page_count(&source_path).unwrap(), 4);

        let jobs = vec![
            (root.join("a.pdf"), 1, 2),
            (root.join("b.pdf"), 2, 2),
            (root.join("c.pdf"), 3, 4),
        ];
        engine.write_ranges(&source_path, &jobs).unwrap();
        assert_eq!(engine.page_count(&jobs[0].0).unwrap(), 2);
        assert_eq!(engine.page_count(&jobs[1].0).unwrap(), 1);
        assert_eq!(engine.page_count(&jobs[2].0).unwrap(), 2);
        let _ = fs::remove_dir_all(&root);
    }
}
