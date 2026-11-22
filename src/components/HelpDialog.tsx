import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const TABS = [
  { id: "about", label: "简介" },
  { id: "use", label: "操作" },
  { id: "names", label: "文件名" },
  { id: "checks", label: "检查" },
  { id: "keep", label: "保存" },
] as const;

type TabId = (typeof TABS)[number]["id"];

type Props = {
  onClose: () => void;
};

export function HelpDialog({ onClose }: Props) {
  const [tab, setTab] = useState<TabId>("about");
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function beginResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = dialog.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== event.pointerId) return;
      const width = clamp(rect.width + ev.clientX - startX, 420, window.innerWidth - 32);
      const height = clamp(rect.height + ev.clientY - startY, 320, window.innerHeight - 32);
      dialog.style.width = `${Math.round(width)}px`;
      dialog.style.height = `${Math.round(height)}px`;
    };
    const stop = (ev: PointerEvent) => {
      if (ev.pointerId !== event.pointerId) return;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
  }

  return (
    <div className="help-backdrop" onMouseDown={onClose}>
      <div
        className="help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="help-head">
          <div>
            <p className="help-kicker">使用手记</p>
            <h2 id="help-title">说明</h2>
          </div>
          <button type="button" className="help-close" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="help-tabs" role="tablist" aria-label="说明分类">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`help-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`help-panel-${item.id}`}
              className={tab === item.id ? "on" : ""}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div
          className="help-body"
          role="tabpanel"
          id={`help-panel-${tab}`}
          aria-labelledby={`help-tab-${tab}`}
        >
          {tab === "about" ? <About /> : null}
          {tab === "use" ? <Use /> : null}
          {tab === "names" ? <Names /> : null}
          {tab === "checks" ? <Checks /> : null}
          {tab === "keep" ? <Keep /> : null}
        </div>
        <button type="button" className="help-resize" aria-label="拖动调整窗口大小" title="拖动调整窗口大小" onPointerDown={beginResize} />
      </div>
    </div>
  );
}

function About() {
  return (
    <>
      <p>PDF拆分器把一本多章节的 PDF，按你标出的起止页，拆成多个 PDF 文件。</p>
      <p>同一页可以同时属于两个章节。上一章结束在第 3 页时，下一章也可以从第 3 页开始，这一页会分别写进两个文件。</p>
      <p>预览里的页码、淡黄色遮罩和红色边框只出现在屏幕上，不会写进导出的 PDF。</p>
      <p>程序在这台电脑上运行，不把文件上传到别处。</p>
    </>
  );
}

function Use() {
  return (
    <>
      <p>点「打开 PDF」。书籍总名默认是原文件名，可以修改。它会用在每个拆分文件的名字里。</p>
      <p>左侧把各页接成一条，滚轮往下看。按住 Ctrl 再滚动，可以缩放页面。工具条上的页码，跟着靠近视野顶部的那一页变化。</p>
      <p>右侧表格的最后一行始终空着。在里面填起始页、结束页或标题，就会成为新的一章，下面再出现一行空白。整行都空着的，拆分时自动忽略。只填了一部分的，会提示补全。</p>
      <p>点某一行的序号，或把光标放进这一行，左侧会滚到该行的起始页。起止页都填好以后，这几页会罩上一层淡黄，并加上红色边框。</p>
      <p>「此页」把结束页设成当前正在看的页，「末页」设成全书最后一页。「看」回到这一章的起始页。起止页相同的两条，可以用「上」「下」调整先后。</p>
      <p>表头右侧的细线可以拖动，用来改变列宽。预览区和编辑区中间的分隔条也可以拖动。这些宽度会记住，下次打开仍然使用。</p>
      <p>页脚的「导出配置」和「导入配置」，把当前表格存成 JSON，或从 JSON 读回来。导出时的文件名，用的是当时的书籍总名。</p>
    </>
  );
}

function Names() {
  return (
    <>
      <p>编辑区上方可以选择序号样式：卷、篇、章、节、回，也可以不选。</p>
      <p>选了「章」，并且填写了标题时，文件名形如：总名-第1章-封面.pdf。标题留空时，则是：总名-第1章.pdf。篇、节、回、卷也是同样的写法。</p>
      <p>不选择序号样式时，需要填写标题。文件名形如：总名-01-封面.pdf。章节到了一百条以上，序号会写成三位。</p>
      <h3>写到哪里</h3>
      <p>拆出来的文件放在「书籍总名-章节拆分」文件夹里。还没改过目录时，这个文件夹就在原 PDF 旁边。</p>
      <p>点「更改目录」之后，页脚会显示所选的目录。文件仍放在该目录下的「书籍总名-章节拆分」文件夹中。</p>
      <p>再次拆分同一本书时，会替换这个文件夹里上次生成的文件，旁边无关的文件会留下。</p>
      <p>标题过长时，只缩短标题那一段，序号保留。文件名里不能使用的字符会被去掉。</p>
    </>
  );
}

function Checks() {
  return (
    <>
      <p>表格下方会随时列出问题，不必等到点「开始拆分」。点下去时，会再查一遍。</p>
      <h3>不能拆分</h3>
      <p>有页没有归入任何章节。例如全书 10 页，只标了 1–3 和 5–10，第 4 页会被单独指出来。</p>
      <p>后一条盖住了前面的章节。第 1–3 页是第一章时，下一条可以从第 3 页开始，不能从第 2 页开始。完全落在前面某条里面的，同样不能拆。</p>
      <p>起始页大于结束页、页码超出全书、缺起止页、没有可用标题，或者整理后的文件名重复，也不能拆。</p>
      <h3>确认后可以继续</h3>
      <p>同一页同时属于三个或更多章节时，会提醒。属于两个章节是正常的，不提示。</p>
      <p>起止页和标题都相同的记录添加了多次，也会提醒。确认之后仍然可以拆分。</p>
      <p>有红色的「不能拆分」时，开始按钮不可用。只有黄色的「请确认」时，点下去会先把这些问题列出来。</p>
    </>
  );
}

function Keep() {
  return (
    <>
      <p>标记会自动保存。下次打开同一份 PDF，可以选择接着用上次的标记，或重新开始。</p>
      <p>导入配置时，如果表格里已经有记录，会先询问是否替换。导入会恢复各章的起止页、标题，以及卷、篇、章、节、回的选择，不会改掉当前的书籍总名。</p>
      <h3>安装</h3>
      <p>安装包按当前用户安装，不要求管理员权限。安装完成后，从开始菜单打开「PDF拆分器」。</p>
      <p>第一次运行时，Windows 可能显示「Windows 已保护你的电脑」。这是因为安装包还没有代码签名。可以点「更多信息」，再点「仍要运行」。</p>
    </>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
