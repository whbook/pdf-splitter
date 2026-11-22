use pdfium_render::prelude::*;
use std::path::PathBuf;

fn main() {
    let dll_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&dll_dir))
        .expect("加载 pdfium.dll");
    let pdfium = Pdfium::new(bindings);
    let mut document = pdfium.create_new_pdf().expect("创建 PDF");
    for _ in 0..8 {
        drop(
            document
                .pages_mut()
                .create_page_at_end(PdfPagePaperSize::Portrait(PdfPagePaperStandardSize::A4))
                .expect("添加页面"),
        );
    }
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("sample-8pages.pdf");
    document.save_to_file(&output).expect("保存");
    println!("{}", output.display());
}
