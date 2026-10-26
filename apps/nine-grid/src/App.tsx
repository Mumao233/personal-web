import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type PointerEvent } from 'react';
import { ArrowClockwise, ArrowCounterClockwise, ArrowDown, ArrowLeft, ArrowsOutCardinal, Check, CheckCircle, Copy, DownloadSimple, GridNine, ImageSquare, Images, Info, LockSimple, Plus, SlidersHorizontal, Trash, UploadSimple, X } from '@phosphor-icons/react';
import { downloadBlob, exportPage, exportPages, getLayout, loadPhoto, panCell, releasePhotoAssets } from './engine';
import { createCell, createPage, type Cell, type GridPage, type PhotoAsset, type Resolution } from './types';
import { Preview } from './Preview';
import { useHistory } from './useHistory';
import { useTheme } from '../../../src/theme.jsx';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/gif,image/bmp';
type Notice = { text: string; error?: boolean };
type PointerAction = { index: number; startX: number; startY: number; moved: boolean; original: Cell; asset: PhotoAsset; size: number; crop: boolean };
const nextPageNumber = (pages: GridPage[]) => Math.max(0, ...pages.map(p => Number(p.name.match(/^画布 (\d+)$/)?.[1]) || 0)) + 1;

export default function App() {
  // Follow the site's saved theme and cross-tab updates without another switch.
  useTheme();
  const history = useHistory();
  const { document: doc, current, change, beginGesture, endGesture, undo, redo, canUndo, canRedo } = history;
  const page = doc.pages.find(p => p.id === doc.activePageId) ?? doc.pages[0];
  const [selected, setSelected] = useState<number | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState('');
  const [dragOver, setDragOver] = useState<number | 'upload' | null>(null);
  const [movingCell, setMovingCell] = useState<number | null>(null);
  const [help, setHelp] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<{ pageId: string; index: number } | null>(null);
  const action = useRef<PointerAction | null>(null);
  const skipClick = useRef(false);
  const importLock = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedCell = selected === null ? null : page.cells[selected];
  const selectedAsset = doc.assets.find(a => a.id === selectedCell?.assetId);
  const occupied = page.cells.filter(Boolean).length;
  const rects = getLayout(1200, doc.settings);

  function notify(text: string, error = false) {
    if (timer.current) clearTimeout(timer.current);
    setNotice({ text, error });
    timer.current = setTimeout(() => setNotice(null), error ? 8500 : 4000);
  }

  useEffect(() => () => { releasePhotoAssets(); if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    function stop(e: DragEvent | globalThis.DragEvent) { e.preventDefault(); }
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const editingText = (e.target instanceof HTMLInputElement && !['range', 'button', 'file', 'checkbox'].includes(e.target.type)) || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable);
      if (editingText || help || importing || exporting) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      if (e.key === 'Escape') { setCropMode(false); setSelected(null); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) { e.preventDefault(); setCell(selected, null); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (!help) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setHelp(false); }
      if (e.key === 'Tab') {
        const buttons = Array.from(window.document.querySelectorAll<HTMLButtonElement>('.help-modal button'));
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (e.shiftKey && window.document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && window.document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); window.document.querySelector<HTMLButtonElement>('.help-button')?.focus(); };
  }, [help]);
  useEffect(() => {
    const hasWork = doc.assets.length > 0 || doc.pages.length > 1;
    if (!hasWork) return;
    const prevent = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [doc.assets.length, doc.pages.length]);

  function setCell(index: number, cell: Cell | null, pageId = page.id) {
    change(d => ({ ...d, pages: d.pages.map(p => p.id === pageId ? { ...p, cells: p.cells.map((c, i) => i === index ? cell : c) } : p) }));
  }
  function patchCell(patch: Partial<Cell>) { if (selected !== null && selectedCell) setCell(selected, { ...selectedCell, ...patch }); }

  async function importFiles(files: FileList | File[], target?: { pageId: string; index: number }) {
    if (!files.length || importLock.current) return;
    importLock.current = true;
    setImporting(true);
    const loaded: PhotoAsset[] = [];
    const errors: string[] = [];
    const destination = target?.pageId ?? current.current.activePageId;
    try {
      for (const file of Array.from(files)) {
        try { loaded.push(await loadPhoto(file)); } catch (error) { errors.push(error instanceof Error ? error.message : `${file.name} 无法读取`); }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (loaded.length) {
        change(d => {
          const pages = d.pages.map(p => ({ ...p, cells: [...p.cells] }));
          let active = pages.find(p => p.id === destination) ?? pages[0];
          let startIndex = target?.index ?? 0;
          loaded.forEach((asset, i) => {
            if (i === 0 && target) { active.cells[startIndex] = createCell(asset.id); return; }
            let free = active.cells.findIndex((c, index) => !c && index >= startIndex);
            if (free < 0) free = active.cells.findIndex(c => !c);
            if (free < 0) { active = createPage(`画布 ${nextPageNumber(pages)}`); pages.push(active); free = 0; }
            active.cells[free] = createCell(asset.id);
            startIndex = free + 1;
          });
          return { ...d, assets: [...d.assets, ...loaded], pages };
        });
        if (target && target.pageId === page.id) setSelected(target.index);
      }
      notify(errors.length ? `已导入 ${loaded.length} 张；${errors.slice(0, 2).join('；')}` : `已导入 ${loaded.length} 张照片${loaded.length > 9 ? '，已自动分配到多个画布' : ''}`, errors.length > 0);
    } finally { setImporting(false); importLock.current = false; }
  }
  function onUpload(e: ChangeEvent<HTMLInputElement>) { if (e.target.files) void importFiles(e.target.files); e.target.value = ''; }
  function pickCell(index: number) { replaceTarget.current = { pageId: page.id, index }; replaceRef.current?.click(); }
  function placeAsset(assetId: string, index?: number) {
    const destination = index ?? selected ?? page.cells.findIndex(c => !c);
    if (destination < 0) { notify('画布已满，请先选择要替换的格子，或新增画布。'); return; }
    setCell(destination, createCell(assetId)); setSelected(destination);
  }
  function dropOn(e: DragEvent, index?: number) {
    e.preventDefault(); e.stopPropagation(); setDragOver(null);
    if (importing || exporting) return;
    if (e.dataTransfer.files.length) { void importFiles(e.dataTransfer.files, index === undefined ? undefined : { pageId: page.id, index }); return; }
    const id = e.dataTransfer.getData('application/x-nine-grid-photo');
    if (doc.assets.some(a => a.id === id)) placeAsset(id, index);
  }
  function swapCells(from: number, to: number) {
    change(d => ({ ...d, pages: d.pages.map(p => { if (p.id !== page.id) return p; const cells = [...p.cells]; [cells[from], cells[to]] = [cells[to], cells[from]]; return { ...p, cells }; }) }));
    setSelected(to);
  }
  function pointerDown(e: PointerEvent<HTMLButtonElement>, index: number) {
    if (e.button !== 0 || !page.cells[index]) return;
    const cell = page.cells[index]!;
    const asset = doc.assets.find(a => a.id === cell.assetId);
    if (!asset) return;
    setSelected(index);
    beginGesture();
    action.current = { index, startX: e.clientX, startY: e.clientY, original: cell, asset, moved: false, size: e.currentTarget.getBoundingClientRect().width, crop: cropMode };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function pointerMove(e: PointerEvent<HTMLButtonElement>) {
    const a = action.current;
    if (!a) return;
    const dx = e.clientX - a.startX; const dy = e.clientY - a.startY;
    if (Math.hypot(dx, dy) < 5 && !a.moved) return;
    a.moved = true;
    if (a.crop) setCell(a.index, panCell(a.original, a.asset, dx, dy, a.size));
    else {
      setMovingCell(a.index);
      const target = window.document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-cell-index]');
      setDragOver(target ? Number(target.getAttribute('data-cell-index')) : null);
    }
  }
  function pointerUp(e: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const a = action.current;
    if (!a) return;
    if (!cancelled && a.moved && !a.crop) {
      const target = window.document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-cell-index]');
      const index = target ? Number(target.getAttribute('data-cell-index')) : -1;
      if (index >= 0 && index !== a.index) swapCells(a.index, index);
    }
    skipClick.current = a.moved;
    action.current = null; setMovingCell(null); setDragOver(null); endGesture();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }
  function batchGenerate() {
    change(d => {
      const generated = Array.from({ length: Math.ceil(d.assets.length / 9) }, (_, i) => {
        const next = createPage(`画布 ${nextPageNumber(d.pages) + i}`);
        d.assets.slice(i * 9, i * 9 + 9).forEach((a, index) => { next.cells[index] = createCell(a.id); });
        return next;
      });
      if (!generated.length) return d;
      return { ...d, pages: [...d.pages, ...generated], activePageId: generated[0].id };
    });
    setSelected(null); setCropMode(false);
    notify(`已用全部素材新增 ${Math.ceil(doc.assets.length / 9)} 张画布，原有作品已保留。`);
  }
  async function onExport(all = false) {
    if (exporting) return;
    setExporting(true); setProgress(all ? '正在准备打包…' : '正在生成高清图片…');
    try {
      const blob = all ? await exportPages(doc.pages, doc.assets, doc.settings, (done, total) => setProgress(`正在导出 ${done} / ${total}`)) : await exportPage(page, doc.assets, doc.settings);
      downloadBlob(blob, all ? `九格-${doc.pages.length}张画布.zip` : `九格-${page.name}-${doc.settings.resolution}.png`);
      notify(all ? '全部画布已打包，请在下载列表中查看。' : '图片已导出，请在下载列表中查看。');
    } catch (error) { notify(error instanceof Error ? error.message : '导出失败，请重试或降低分辨率。', true); }
    finally { setExporting(false); setProgress(''); }
  }
  function updateSetting(key: 'gap' | 'padding', value: number) { change(d => ({ ...d, settings: { ...d.settings, [key]: value } })); }
  function navigate(id: string) { change(d => ({ ...d, activePageId: id }), false); setSelected(null); setCropMode(false); }
  function newPage(copy = false) {
    change(d => { const next = createPage(`画布 ${nextPageNumber(d.pages)}`); if (copy) next.cells = page.cells.map(c => c ? { ...c } : null); return { ...d, pages: [...d.pages, next], activePageId: next.id }; });
    setSelected(null); setCropMode(false);
  }
  function deletePage() {
    if (doc.pages.length < 2) return;
    change(d => { const pages = d.pages.filter(p => p.id !== page.id); return { ...d, pages, activePageId: pages[0].id }; }); setSelected(null);
    notify('画布已删除，可撤销恢复。');
  }
  const gestureProps = { onPointerDown: beginGesture, onPointerUp: endGesture, onPointerCancel: endGesture, onBlur: endGesture, onKeyUp: endGesture };

  return <div className="app-shell">
    <a className="skip-editor" href="#nine-grid-editor">跳到图片编辑区</a>
    <header className="app-header">
      <div className="site-identity">
        <span className="site-wordmark">林珈诚<span>个人空间</span></span>
        <span className="site-identity-divider" aria-hidden="true" />
        <div className="brand" aria-label="九格图片工具"><span className="brand-icon"><GridNine size={24} weight="fill" /></span><span className="brand-name">九格<span className="brand-subtitle">图片工具</span></span></div>
      </div>
      <div className="header-actions"><a className="site-back-link" href="/?page=projects"><ArrowLeft size={16} />返回作品与项目</a><span className="local-badge"><LockSimple size={14} /> 照片只留在你的设备</span><button className="icon-button help-button" aria-label="使用帮助" title="使用帮助" onClick={() => setHelp(true)}><Info size={21} /></button></div>
    </header>

    <div className="workspace">
      <aside className="left-panel panel">
        <div className="section-heading"><h2>照片素材</h2><span className="count-badge">{doc.assets.length}</span></div>
        <p className="section-description">把日常，装进九个小格。</p>
        <button className={`upload-zone ${dragOver === 'upload' ? 'is-dragover' : ''}`} onClick={() => uploadRef.current?.click()} onDragOver={e => { e.preventDefault(); setDragOver('upload'); }} onDragLeave={() => setDragOver(null)} onDrop={e => dropOn(e)} disabled={importing || exporting}>
          <span className="upload-icon"><UploadSimple size={24} /></span><strong>{importing ? '正在读取照片…' : '点击或拖拽上传'}</strong><span>支持多张图片一起添加</span><small>JPG、PNG、WebP 等常用格式</small>
        </button>
        <input ref={uploadRef} data-testid="upload-input" aria-label="上传多张照片" className="hidden-input" type="file" accept={ACCEPT} multiple onChange={onUpload} />
        <input ref={replaceRef} data-testid="replace-input" aria-label="上传或替换格子照片" className="hidden-input" type="file" accept={ACCEPT} onChange={e => { if (e.target.files && replaceTarget.current) void importFiles(e.target.files, replaceTarget.current); e.target.value = ''; }} />
        <div className="library-heading"><span>我的照片</span><span>{doc.assets.length} 张</span></div>
        {doc.assets.length ? <div className="photo-library">{doc.assets.map((asset, index) => <button key={asset.id} className={`photo-thumb ${selectedAsset?.id === asset.id ? 'is-active' : ''}`} draggable onDragStart={e => { e.dataTransfer.setData('application/x-nine-grid-photo', asset.id); e.dataTransfer.effectAllowed = 'copy'; }} onClick={() => placeAsset(asset.id)} title={`${asset.name} · ${asset.width} × ${asset.height}`} aria-label={`放入照片 ${index + 1}：${asset.name}`} disabled={exporting || importing}><img src={asset.url} alt={asset.name} draggable={false} /><span className="photo-number">{String(index + 1).padStart(2, '0')}</span>{page.cells.some(c => c?.assetId === asset.id) && <span className="photo-used"><Check size={10} weight="bold" /></span>}</button>)}</div> : <div className="library-empty"><Images size={34} weight="thin" /><p>你的照片会显示在这里</p><span>上传后自动排入画布，也可自由拖放</span></div>}
        <div className="library-bottom"><button className="button secondary full-width" disabled={!doc.assets.length || exporting || importing} onClick={batchGenerate}><GridNine size={17} />批量生成</button><p>全部素材按每 9 张新增一张画布</p></div>
        <div className="privacy-note"><LockSimple size={15} /><span>照片仅在浏览器中处理。<br />关闭页面前记得导出。</span></div>
      </aside>

      <main className="editor" id="nine-grid-editor" tabIndex={-1} aria-label="九格图片编辑区">
        <div className="editor-heading"><div><span className="eyebrow">让照片刚刚好</span><h1>留一点白，<br className="mobile-break" />多一点美好。</h1></div><span className="layout-badge"><GridNine size={16} />3 × 3 布局</span></div>
        <div className="editor-toolbar"><div className="mode-switch" aria-label="编辑模式"><button className={!cropMode ? 'active' : ''} onClick={() => setCropMode(false)} aria-pressed={!cropMode}><GridNine size={16} />排版</button><button className={cropMode ? 'active' : ''} onClick={() => setCropMode(true)} aria-pressed={cropMode}><ArrowsOutCardinal size={16} />调整裁切</button></div><div className="history-actions"><button className="icon-button" aria-label="撤销" title="撤销 (Ctrl+Z)" disabled={!canUndo || importing || exporting} onClick={undo}><ArrowCounterClockwise size={18} /></button><button className="icon-button" aria-label="重做" title="重做 (Ctrl+Shift+Z)" disabled={!canRedo || importing || exporting} onClick={redo}><ArrowClockwise size={18} /></button><span className="toolbar-divider" /><span className="canvas-ratio">1 : 1</span></div></div>
        <div className="stage">
          <div className={`canvas-wrap ${cropMode ? 'crop-mode' : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => dropOn(e)}>
            <Preview page={page} assets={doc.assets} settings={doc.settings} className="main-canvas" onError={text => notify(text, true)} />
            <div className="cell-overlays">{rects.map((rect, index) => {
              const cell = page.cells[index];
              return <button key={index} data-testid={`grid-cell-${index}`} data-cell-index={index} data-asset-id={cell?.assetId ?? ''} className={`grid-cell ${cell ? 'has-image' : 'is-empty'} ${selected === index ? 'is-selected' : ''} ${dragOver === index ? 'is-dragover' : ''} ${movingCell === index ? 'is-moving' : ''}`} style={{ left: `${rect.x / 12}%`, top: `${rect.y / 12}%`, width: `${rect.size / 12}%`, height: `${rect.size / 12}%` }} aria-label={`格子 ${index + 1}${cell ? '，已有照片，点击选择，双击替换' : '，空白，点击添加照片'}`} aria-pressed={selected === index} disabled={exporting || importing} onClick={() => { if (skipClick.current) { skipClick.current = false; return; } setSelected(index); if (!cell) pickCell(index); }} onDoubleClick={() => { if (cell) pickCell(index); }} onPointerDown={e => pointerDown(e, index)} onPointerMove={pointerMove} onPointerUp={e => pointerUp(e)} onPointerCancel={e => pointerUp(e, true)} onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOver(index); }} onDragLeave={() => setDragOver(null)} onDrop={e => dropOn(e, index)}>
                {!cell && <><Plus size={23} weight="light" /><span>添加照片</span></>}
                {cell && selected === index && <span className="cell-selected-mark"><Check size={11} weight="bold" /></span>}
              </button>;
            })}</div>
          </div>
          <div className="canvas-caption"><span>{page.name}<span className="caption-dot">·</span>{occupied} / 9 张照片</span><span>{doc.settings.resolution} × {doc.settings.resolution} px</span></div>
        </div>
        <p className="interaction-hint"><ArrowsOutCardinal size={15} />{cropMode ? '拖动照片调整裁切，右侧滑杆可缩放' : '拖动照片交换位置，点击空白格添加照片'}</p>
        <div className="pages-section"><div className="pages-heading"><span>我的画布 <b>{doc.pages.length}</b></span><div><button className="icon-button" aria-label="复制当前画布" title="复制当前画布" onClick={() => newPage(true)} disabled={exporting || importing}><Copy size={16} /></button><button className="icon-button" aria-label="删除当前画布" title="删除当前画布" onClick={deletePage} disabled={doc.pages.length <= 1 || exporting || importing}><Trash size={16} /></button></div></div><div className="page-list">{doc.pages.map((p, i) => <button key={p.id} className={`page-item ${page.id === p.id ? 'active' : ''}`} onClick={() => navigate(p.id)} aria-label={`切换到${p.name}`} aria-pressed={page.id === p.id}><Preview page={p} assets={doc.assets} settings={doc.settings} size={150} /><span>{String(i + 1).padStart(2, '0')}</span></button>)}<button className="new-page" aria-label="新增画布" onClick={() => newPage()} disabled={exporting || importing}><Plus size={22} /><span>新增画布</span></button></div></div>
      </main>

      <aside className="right-panel panel">
        <div className="section-heading"><h2>画布设置</h2><SlidersHorizontal size={19} className="muted" /></div>
        <section className="settings-section"><h3>排版留白</h3>
          <div className="slider-field"><label htmlFor="gap">格子间距 <span>{doc.settings.gap.toFixed(1)}<small>%</small></span></label><input id="gap" aria-label="格子间距" type="range" min="0" max="6" step="0.1" value={doc.settings.gap} onChange={e => updateSetting('gap', +e.target.value)} {...gestureProps} /><div className="range-labels"><span>紧凑</span><span>宽松</span></div></div>
          <div className="slider-field"><label htmlFor="padding">四周留白 <span>{doc.settings.padding.toFixed(1)}<small>%</small></span></label><input id="padding" aria-label="四周留白" type="range" min="0" max="12" step="0.1" value={doc.settings.padding} onChange={e => updateSetting('padding', +e.target.value)} {...gestureProps} /><div className="range-labels"><span>铺满</span><span>留白</span></div></div>
          <div className="background-row"><span>背景颜色</span><span><i />纯白</span></div>
        </section>
        <section className="settings-section resolution-section"><h3>导出尺寸</h3><div className="resolution-options">{([1080, 2048, 3000, 4096] as Resolution[]).map(res => <button key={res} aria-pressed={doc.settings.resolution === res} className={doc.settings.resolution === res ? 'active' : ''} onClick={() => change(d => ({ ...d, settings: { ...d.settings, resolution: res } }))}>{res}<span>{res === 1080 ? '日常分享' : res === 2048 ? '清晰大图' : res === 3000 ? '推荐 · 高清' : '超大尺寸'}</span></button>)}</div><p className="format-note"><CheckCircle size={14} />PNG 无损格式 · 保留白色背景</p></section>
        <section className={`settings-section crop-section ${selectedCell ? 'has-selection' : ''}`}><div className="section-heading"><h3>照片调整</h3>{selectedCell && <span className="selection-label">格子 {selected! + 1}</span>}</div>{selectedCell && selectedAsset ? <><div className="selected-photo"><img src={selectedAsset.url} alt="已选照片" /><div><strong title={selectedAsset.name}>{selectedAsset.name}</strong><span>{selectedAsset.width} × {selectedAsset.height} px</span></div></div><div className="slider-field"><label htmlFor="zoom">照片缩放 <span>{Math.round(selectedCell.zoom * 100)}<small>%</small></span></label><input id="zoom" aria-label="照片缩放" type="range" min="1" max="4" step="0.01" value={selectedCell.zoom} onChange={e => patchCell({ zoom: +e.target.value })} {...gestureProps} /></div><button className={`button secondary full-width crop-button ${cropMode ? 'selected' : ''}`} onClick={() => setCropMode(!cropMode)}><ArrowsOutCardinal size={16} />{cropMode ? '完成裁切调整' : '移动照片调整裁切'}</button><div className="photo-actions"><button onClick={() => pickCell(selected!)}>替换照片</button><button onClick={() => patchCell({ zoom: 1, x: .5, y: .5 })}>重置裁切</button><button className="danger" onClick={() => setCell(selected!, null)}>清空格子</button></div></> : <div className="crop-empty"><span className="crop-placeholder"><ImageSquare size={25} weight="thin" /></span><p>选中一张照片</p><span>缩放、移动，找到喜欢的画面</span></div>}</section>
        <div className="tips"><Info size={17} /><p>空白也是画面的一部分。<br />不必填满九格，留白会完整保留。</p></div>
      </aside>
    </div>

    <footer className="export-bar"><div className="export-summary"><span className="export-icon"><ImageSquare size={21} /></span><div><strong>{exporting ? progress : '好好排版，清晰保存。'}</strong><span>{doc.settings.resolution} × {doc.settings.resolution} px<span className="caption-dot">·</span>PNG<span className="caption-dot">·</span>{doc.pages.length} 张画布</span></div></div><div className="export-actions"><button className="button secondary" disabled={exporting || importing} onClick={() => void onExport(true)}><DownloadSimple size={17} />导出全部<span className="zip-tag">ZIP</span></button><button className="button primary" disabled={exporting || importing} onClick={() => void onExport()}>{exporting ? <span className="spinner" /> : <ArrowDown size={19} weight="bold" />}<span>{exporting ? '正在导出…' : '导出图片'}</span></button></div></footer>
    {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role="status">{notice.error ? <Info size={18} /> : <CheckCircle size={18} />}<span>{notice.text}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button></div>}
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={e => e.stopPropagation()}><button className="icon-button modal-close" autoFocus aria-label="关闭帮助" onClick={() => setHelp(false)}><X size={20} /></button><span className="brand-icon"><GridNine size={25} weight="fill" /></span><h2 id="help-title">几步，拼出喜欢的画面。</h2><ol><li><strong>添加照片</strong><p>多选上传或直接拖入画布。超过 9 张会自动增加画布。</p></li><li><strong>自由排版</strong><p>拖动照片交换格子。点击照片选中，双击替换。空白格可一直留空。</p></li><li><strong>调整裁切</strong><p>切换到「调整裁切」，拖动移动照片，使用右侧滑杆缩放。始终保持原比例。</p></li><li><strong>高清导出</strong><p>导出当前 PNG，或将全部画布打包为 ZIP。画面边框和加号不会导出。</p></li></ol><div className="shortcut-note">撤销 <kbd>Ctrl Z</kbd>　重做 <kbd>Ctrl Shift Z</kbd><br /><small>Mac 使用 ⌘ 键。设置对所有画布生效。刷新或关闭页面会清空当前编辑，请先导出。</small></div><button className="button primary full-width" onClick={() => setHelp(false)}>开始创作</button></section></div>}
  </div>;
}
