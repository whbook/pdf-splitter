# PDF拆分器

预览 PDF，手工标记每一章的起始页、结束页和标题，再拆成多个文件。选了「章」等单位时，文件名是「总名-第1章-标题」，标题留空则是「总名-第1章」；不选时是「总名-01-标题」。

## 开发

需要 Node.js、Rust（MSVC）和 Visual Studio 的 C++ 生成工具。PDF 组件使用 PDFium 8125，文件放在 `src-tauri/resources/pdfium.dll`。

```powershell
npm install
npm run tauri dev
```

```powershell
cd src-tauri
cargo test
```

## 安装包

```powershell
npm run tauri build
```

只生成一个 NSIS 安装包：`src-tauri/target/release/bundle/nsis/PDF拆分器_0.1.0_x64-setup.exe`。安装包带有离线的 WebView2，断网也能安装，因此体积会比较大。

当前没有代码签名证书。用户第一次打开安装包时，Windows 会提示「Windows 已保护你的电脑」，按 `使用说明.txt` 里的步骤继续即可。以后如果有证书，设置下面的环境变量后再打包，安装包和程序都会签名：

- `PDF_SPLITTER_PFX`：证书文件路径
- `PDF_SPLITTER_PFX_PASSWORD`：证书密码
- `PDF_SPLITTER_SIGNTOOL`：可选，signtool.exe 的路径

## 已知限制

按页复制不会保留原书的书签和页内链接。有密码的 PDF 打不开。
