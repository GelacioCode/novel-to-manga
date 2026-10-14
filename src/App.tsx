import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Chapter, Guide, Job, Lettering, Page, ReferenceImage, Series } from "./types";

type SeriesDetail = { series: any; chapters: Chapter[]; references: ReferenceImage[]; guide?: Guide };
type Tab = "chapters" | "references" | "generate" | "reader" | "settings";

export default function App() {
  const [series, setSeries] = useState<Series[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<SeriesDetail>();
  const [tab, setTab] = useState<Tab>("chapters");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const selected = series.find(s => s.id === selectedId);
  const refreshLibrary = async () => setSeries(await api<Series[]>("/api/series"));
  const refreshDetail = async (id = selectedId) => { if (id) setDetail(await api<SeriesDetail>(`/api/series/${id}`)); };
  useEffect(() => { void refreshLibrary(); }, []);
  useEffect(() => { void refreshDetail(); }, [selectedId]);
  const report = (message: string, isError = false) => { isError ? setError(message) : setNotice(message); if (!isError) setError(""); };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="seal">漫</span><div><strong>Novel to Manga</strong><small>Local adaptation studio</small></div></div>
      <nav aria-label="Series library">
        <div className="nav-label">LIBRARY</div>
        {series.map(s => <button key={s.id} className={`series-link ${selectedId === s.id ? "active" : ""}`} onClick={() => { setSelectedId(s.id); setTab("chapters"); }}>
          <span>{s.title}</span><small>{s.completedCount}/{s.chapterCount} chapters</small>
        </button>)}
      </nav>
      <CreateSeries onCreated={async id => { await refreshLibrary(); setSelectedId(id); }} report={report} />
      <div className="local-badge"><i /> Local workspace</div>
    </aside>
    <main>
      {!selectedId ? <Welcome hasSeries={series.length > 0} /> : <>
        <header className="topbar">
          <div><p className="eyebrow">SERIES</p><h1>{selected?.title}</h1></div>
          <div className="status-pair"><span>{detail?.chapters.length ?? 0} sources</span><span>{selected?.completedCount ?? 0} adapted</span></div>
        </header>
        <div className="tabs">{(["chapters","references","generate","reader","settings"] as Tab[]).map(t => <button className={tab === t ? "active" : ""} onClick={() => setTab(t)} key={t}>{t}</button>)}</div>
        {notice && <div className="notice" onClick={() => setNotice("")}>{notice}</div>}
        {error && <div className="notice error" onClick={() => setError("")}>{error}</div>}
        <section className="content">
          {tab === "chapters" && <Chapters seriesId={selectedId} chapters={detail?.chapters ?? []} refresh={() => refreshDetail()} report={report} />}
          {tab === "references" && <References seriesId={selectedId} detail={detail} refresh={() => { void refreshDetail(); void refreshLibrary(); }} report={report} />}
          {tab === "generate" && <Generate chapters={detail?.chapters ?? []} guide={detail?.guide} onRead={() => setTab("reader")} report={report} />}
          {tab === "reader" && <Reader seriesId={selectedId} chapters={detail?.chapters ?? []} report={report} onImport={() => setTab("chapters")} />}
          {tab === "settings" && <Settings />}
        </section>
      </>}
    </main>
  </div>;
}

function Welcome({ hasSeries }: { hasSeries: boolean }) { return <div className="welcome"><div className="hero-mark">物語<br/>漫画</div><p className="eyebrow">YOUR PRIVATE MANGA SHELF</p><h1>{hasSeries ? "Choose a series to continue." : "Turn chapters into pages, one at a time."}</h1><p>Import prose, establish a visual guide, approve a sample, and generate only when you ask. Everything is saved locally.</p></div>; }

function CreateSeries({ onCreated, report }: { onCreated: (id: string) => void; report: (s: string, e?: boolean) => void }) {
  const [open, setOpen] = useState(false); const [title, setTitle] = useState("");
  const submit = async () => { try { const r = await api<{id:string}>("/api/series", { method: "POST", body: JSON.stringify({ title }) }); setTitle(""); setOpen(false); onCreated(r.id); } catch (e) { report((e as Error).message, true); } };
  return <div className="new-series">{open ? <><input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="Series title" onKeyDown={e => e.key === "Enter" && void submit()} /><div><button onClick={() => void submit()}>Create</button><button className="text" onClick={() => setOpen(false)}>Cancel</button></div></> : <button className="outline full" onClick={() => setOpen(true)}>＋ New series</button>}</div>;
}

function Chapters({ seriesId, chapters, refresh, report }: { seriesId: string; chapters: Chapter[]; refresh: () => void; report: (s: string, e?: boolean) => void }) {
  const [text, setText] = useState(""); const [sourceFile,setSourceFile]=useState(""); const [detected, setDetected] = useState<Array<{identifier:string;title:string;sourceText:string;mappingNote:string;sourceKind?:"paste"|"txt";sourceMetadata?:Record<string,string>}>>([]);
  const detect = async () => { try { const r = await api<{chapters:any[]}>(`/api/series/${seriesId}/detect-chapters`, { method: "POST", body: JSON.stringify({ text }) }); setDetected(r.chapters.map(ch=>({...ch,sourceKind:sourceFile?"txt":"paste",sourceMetadata:sourceFile?{filename:sourceFile,encoding:"UTF-8"}:{method:"pasted text"}}))); } catch(e) { report((e as Error).message, true); } };
  const loadTxt=async(file?:File)=>{if(!file)return;if(!file.name.toLowerCase().endsWith(".txt")){report("Choose a UTF-8 .txt file.",true);return}setText(await file.text());setSourceFile(file.name);report(`${file.name} loaded for boundary review.`)};
  const save = async () => { try { await api(`/api/series/${seriesId}/chapters`, { method: "POST", body: JSON.stringify({ chapters: detected }) }); setText(""); setDetected([]); refresh(); report("Source chapters imported and preserved."); } catch(e) { report((e as Error).message, true); } };
  return <div className="split-layout"><div><SectionHead kicker="NOVEL SOURCES" title="Imported chapters" subtitle="Manga numbering stays separate; mapping notes are yours to define." />
    <div className="chapter-list">{chapters.length ? chapters.map((c, i) => <article className="chapter-row" key={c.id}><span className="chapter-index">{String(i+1).padStart(2,"0")}</span><div><strong>{c.title}</strong><small>Source label: {c.identifier}{c.mappingNote ? ` · ${c.mappingNote}` : ""}</small></div><span className={`pill ${c.status}`}>{c.status}</span></article>) : <Empty text="No chapters imported yet." />}</div>
  </div><div className="paper panel"><p className="eyebrow">IMPORT</p><h2>Paste or load UTF-8 text</h2><p>Paste one chapter or a bulk export. Detected boundaries remain editable before saving.</p><label className="txt-picker"><input type="file" accept=".txt,text/plain" onChange={e=>void loadTxt(e.target.files?.[0])}/>{sourceFile||"Choose UTF-8 TXT"}</label><textarea className="source-input" value={text} onChange={e => {setText(e.target.value);if(sourceFile)setSourceFile("")}} placeholder={'Chapter 1: The Beginning\n\nYour original source text…'} />
    <button className="primary" disabled={!text.trim()} onClick={() => void detect()}>Detect boundaries</button>
    {detected.length > 0 && <div className="detected"><h3>Review {detected.length} chapter{detected.length > 1 ? "s" : ""}</h3>{detected.map((d,i) => <div className="detected-row" key={i}><input value={d.identifier} aria-label="Chapter identifier" onChange={e => setDetected(v => v.map((x,n) => n===i ? {...x,identifier:e.target.value}:x))}/><input value={d.title} aria-label="Chapter title" onChange={e => setDetected(v => v.map((x,n) => n===i ? {...x,title:e.target.value}:x))}/><input value={d.mappingNote} placeholder="Optional manga mapping note" onChange={e => setDetected(v => v.map((x,n) => n===i ? {...x,mappingNote:e.target.value}:x))}/><small>{d.sourceText.length.toLocaleString()} characters</small></div>)}<button className="primary dark" onClick={() => void save()}>Save source chapters</button></div>}
  </div></div>;
}

function References({ seriesId, detail, refresh, report }: { seriesId:string; detail?:SeriesDetail; refresh:()=>void; report:(s:string,e?:boolean)=>void }) {
  const [files,setFiles]=useState<FileList|null>(null); const [tags,setTags]=useState("character, general style"); const [guide,setGuide]=useState(""); const [url,setUrl]=useState(""); const [discovered,setDiscovered]=useState<string[]>([]); const [selectedUrls,setSelectedUrls]=useState<string[]>([]);
  useEffect(()=>setGuide(detail?.guide?.content ?? ""),[detail?.guide?.content]);
  const upload=async()=>{if(!files)return;const fd=new FormData();Array.from(files).forEach(f=>fd.append("images",f));fd.append("tags",tags);try{await api(`/api/series/${seriesId}/references`,{method:"POST",body:fd});refresh();report("References saved locally.");}catch(e){report((e as Error).message,true)}};
  const analyze=async()=>{try{const r=await api<Guide>(`/api/series/${seriesId}/guide/analyze`,{method:"POST",body:JSON.stringify({paidCallsAuthorized:false})});setGuide(r.content);refresh();report("Draft guide created. Review it before approval.");}catch(e){report((e as Error).message,true)}};
  const saveGuide=async(approved:boolean)=>{try{await api(`/api/series/${seriesId}/guide`,{method:"PUT",body:JSON.stringify({content:guide,approved})});refresh();report(approved?"Visual guide approved.":"Visual guide draft saved.");}catch(e){report((e as Error).message,true)}};
  const discover=async()=>{try{const r=await api<{images:string[];note:string}>(`/api/series/${seriesId}/reference-url/discover`,{method:"POST",body:JSON.stringify({url})});setDiscovered(r.images);setSelectedUrls([]);report(r.note);}catch(e){report((e as Error).message,true)}};
  const importUrls=async()=>{try{await api(`/api/series/${seriesId}/reference-url/import`,{method:"POST",body:JSON.stringify({urls:selectedUrls,tags})});setDiscovered([]);setSelectedUrls([]);refresh();report("Selected public images imported.")}catch(e){report((e as Error).message,true)}};
  return <><SectionHead kicker="VISUAL CONTINUITY" title="References & guide" subtitle="References shape appearance and composition. They never supply story events."/><div className="reference-grid"><div className="panel"><h2>Reference library</h2><div className="thumb-grid">{detail?.references.map(r=><figure key={r.id}><img src={r.filePath}/><figcaption>{r.filename}<small>{r.tags.join(" · ")}</small></figcaption></figure>)}{!detail?.references.length&&<Empty text="PNG, JPEG, and WebP up to the configured limit."/>}</div><label className="file-drop"><input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e=>setFiles(e.target.files)}/><span>{files?.length?`${files.length} file(s) selected`:"Choose reference images"}</span></label><input value={tags} onChange={e=>setTags(e.target.value)} placeholder="character, outfit, location…"/><button className="primary" disabled={!files?.length} onClick={()=>void upload()}>Upload references</button><hr/><h3>Optional URL discovery</h3><p className="fine">Inspects a public page only. No paywall or login bypass; images are shown before any import.</p><div className="inline"><input value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://…"/><button onClick={()=>void discover()}>Inspect</button></div>{discovered.length>0&&<div className="discovered-images">{discovered.map(x=><label key={x}><input type="checkbox" checked={selectedUrls.includes(x)} onChange={e=>setSelectedUrls(v=>e.target.checked?[...v,x]:v.filter(y=>y!==x))}/><a href={x} target="_blank" rel="noreferrer">{new URL(x).pathname.split("/").pop()||"image"}</a></label>)}<button className="primary" disabled={!selectedUrls.length} onClick={()=>void importUrls()}>Import {selectedUrls.length} selected</button></div>}</div>
  <div className="panel guide"><div className="guide-head"><div><p className="eyebrow">EDITABLE GUIDE · V{detail?.guide?.version??1}</p><h2>Approved visual language</h2></div>{detail?.guide?.approved&&<span className="approved">✓ Approved</span>}</div><textarea value={guide} onChange={e=>setGuide(e.target.value)} placeholder="Describe character appearance, relative height, clothing, equipment, locations, linework, tones, and composition…"/><div className="button-row"><button onClick={()=>void analyze()} disabled={!detail?.references.length}>Analyze actual images</button><button onClick={()=>void saveGuide(false)}>Save draft</button><button className="primary dark" onClick={()=>void saveGuide(true)} disabled={!guide.trim()}>Approve guide</button></div><p className="fine">In mock mode, analysis is an obvious editable template. Real mode sends the actual selected images to the configured vision provider.</p></div></div></>;
}

function Generate({chapters,guide,onRead,report}:{chapters:Chapter[];guide?:Guide;onRead:()=>void;report:(s:string,e?:boolean)=>void}){
  const [chapterId,setChapterId]=useState(""); const [mode,setMode]=useState<"faithful"|"condensed">("faithful"); const [min,setMin]=useState(4); const [max,setMax]=useState(8); const [job,setJob]=useState<Job>();
  useEffect(()=>{if(!chapterId&&chapters[0])setChapterId(chapters[0].id)},[chapters,chapterId]);
  useEffect(()=>{if(!job||!["queued","running","cancel_requested"].includes(job.status))return;const timer=setInterval(async()=>{const j=await api<Job>(`/api/jobs/${job.id}`);setJob(j);if(j.status==="completed")report(j.sampleOnly?"Sample ready for review.":"Chapter generation complete.")},750);return()=>clearInterval(timer)},[job?.id,job?.status]);
  const start=async(sampleOnly:boolean)=>{try{const j=await api<Job|{state:string;chapterId:string}>("/api/jobs",{method:"POST",body:JSON.stringify({chapterId,mode,pageMin:min,pageMax:max,sampleOnly,paidCallsAuthorized:false})});if("state"in j){report("This chapter is already saved. Open it in the reader.");onRead()}else setJob(j)}catch(e){report((e as Error).message,true)}};
  const approveAndStart=async()=>{try{const result=await api<{pages:Page[]}>(`/api/chapters/${chapterId}/pages`);if(!result.pages[0])throw new Error("The sample page is not available yet.");await api(`/api/pages/${result.pages[0].id}/approve`,{method:"POST"});await start(false)}catch(e){report((e as Error).message,true)}};
  const pagesDone=job?.completedPages??0;
  return <><SectionHead kicker="ADAPTATION DESK" title="Generate deliberately" subtitle="Nothing runs until you click. Future chapters never enter the current context."/><div className="generation-layout"><div className="panel controls"><label>Starting novel chapter<select value={chapterId} onChange={e=>setChapterId(e.target.value)}>{chapters.map(c=><option value={c.id} key={c.id}>{c.identifier} — {c.title}</option>)}</select></label><label>Adaptation style<div className="segmented"><button className={mode==="faithful"?"active":""} onClick={()=>setMode("faithful")}>Faithful</button><button className={mode==="condensed"?"active":""} onClick={()=>setMode("condensed")}>Condensed</button></div></label><div className="range"><label>Minimum pages<input type="number" min="1" value={min} onChange={e=>setMin(+e.target.value)}/></label><label>Maximum pages<input type="number" min={min} value={max} onChange={e=>setMax(+e.target.value)}/></label></div><div className="prereq"><span className={chapters.length?"ok":""}>{chapters.length?"✓":"○"} Source imported</span><span className={guide?.approved?"ok":""}>{guide?.approved?"✓":"○"} Visual guide approved</span></div><button className="primary dark large" disabled={!chapterId||!guide?.approved} onClick={()=>void start(true)}>Generate sample page</button>{job?.status==="completed"&&job.sampleOnly&&<button className="primary large" onClick={()=>void approveAndStart()}>Approve sample & generate chapter</button>}</div>
  <div className="panel job-panel">{job?<><div className="job-title"><div><p className="eyebrow">PERSISTED JOB</p><h2>{job.status.replace("_"," ")}</h2></div><span className={`job-dot ${job.status}`}/></div><ol className="stages">{["validate","extract_and_script","plan_pages","generate_artwork","letter_and_validate","save_chapter"].map((s,i)=>{const current=["validate","extract_and_script","plan_pages","generate_artwork","letter_and_validate","save_chapter","completed"].indexOf(job.stage);return <li className={current>i||job.status==="completed"?"done":current===i?"current":""} key={s}><i/>{s.replaceAll("_"," ")}{s==="generate_artwork"&&job.totalPages>0?<small>{pagesDone}/{job.totalPages} pages saved</small>:null}</li>})}</ol>{job.error&&<p className="error-text">{job.error}</p>}{["queued","running"].includes(job.status)&&<button onClick={()=>void api(`/api/jobs/${job.id}/cancel`,{method:"POST"})}>Cancel between stages</button>}{job.status==="completed"&&<button className="outline" onClick={onRead}>Open reader</button>}</>:<Empty text="Your next generation job will appear here with real stage and page counts."/>}</div></div></>;
}

function Reader({seriesId,chapters,report,onImport}:{seriesId:string;chapters:Chapter[];report:(s:string,e?:boolean)=>void;onImport:()=>void}){
  const completed=chapters.filter(c=>c.status==="completed"); const [chapterId,setChapterId]=useState(""); const [pages,setPages]=useState<Page[]>([]); const [single,setSingle]=useState(false); const [rtl,setRtl]=useState(true); const [zoom,setZoom]=useState(100); const [pageIndex,setPageIndex]=useState(0);
  useEffect(()=>{if(!chapterId&&completed[0])setChapterId(completed[0].id)},[completed,chapterId]);
  useEffect(()=>{if(chapterId)void api<{pages:Page[]}>(`/api/chapters/${chapterId}/pages`).then(r=>{setPages(r.pages);setPageIndex(0)})},[chapterId]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(!single)return;if(e.key==="ArrowRight")setPageIndex(i=>Math.max(0,Math.min(pages.length-1,i+(rtl?-1:1))));if(e.key==="ArrowLeft")setPageIndex(i=>Math.max(0,Math.min(pages.length-1,i+(rtl?1:-1))))};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key)},[single,rtl,pages.length]);
  const next=async()=>{if(!chapterId)return;try{const r=await api<any>(`/api/chapters/${chapterId}/next`,{method:"POST"});if(r.state==="completed")setChapterId(r.chapterId);else if(r.state==="not_started"){const j=await api<Job>("/api/jobs",{method:"POST",body:JSON.stringify({chapterId:r.chapterId,mode:"faithful",pageMin:4,pageMax:8,sampleOnly:false,paidCallsAuthorized:false})});report(`Next chapter job ${j.status}.`)}else report(`Next chapter is ${r.state}; reconnected to its existing job.`)}catch(e){if((e as any).code==="source_missing")onImport();report((e as Error).message,true)}};
  return <><div className="reader-toolbar"><select value={chapterId} onChange={e=>setChapterId(e.target.value)}><option value="">Choose a completed chapter</option>{completed.map(c=><option value={c.id} key={c.id}>{c.title}</option>)}</select><div className="segmented"><button className={!single?"active":""} onClick={()=>setSingle(false)}>Scroll</button><button className={single?"active":""} onClick={()=>setSingle(true)}>Single page</button></div><button onClick={()=>setRtl(v=>!v)}>{rtl?"RTL":"LTR"}</button><label className="zoom">Zoom <input type="range" min="55" max="130" value={zoom} onChange={e=>setZoom(+e.target.value)}/></label></div>
  {!pages.length?<div className="reader-empty"><div>頁</div><h2>No saved pages yet</h2><p>Complete a chapter generation to read it here.</p></div>:<div className={`reader ${single?"single":"scroll"}`} dir={rtl?"rtl":"ltr"}>{(single?[pages[pageIndex]]:pages).filter(Boolean).map(p=><MangaPage page={p} zoom={zoom} report={report} key={p.id}/>)}</div>}
  {pages.length>0&&<div className="reader-footer"><button disabled={!single||pageIndex===0} onClick={()=>setPageIndex(i=>i-1)}>Previous page</button><span>{single?`${pageIndex+1} / ${pages.length}`:`${pages.length} saved pages`} · AI-generated adaptation</span><button className="primary dark" onClick={()=>void next()}>Next chapter →</button></div>}</>;
}

function MangaPage({page,zoom,report}:{page:Page;zoom:number;report:(s:string,e?:boolean)=>void}){
  const [lettering,setLettering]=useState<Lettering[]>(page.lettering); const [editing,setEditing]=useState(false);
  const save=async()=>{try{await api(`/api/pages/${page.id}/lettering`,{method:"PUT",body:JSON.stringify({lettering})});setEditing(false);report("Lettering saved without regenerating artwork.")}catch(e){report((e as Error).message,true)}};
  return <article className="manga-page" style={{width:`${zoom}%`}}><div className="page-canvas"><img src={page.imagePath}/>{lettering.map((l,i)=><div className={`balloon ${l.kind}`} style={{left:`${l.x}%`,top:`${l.y}%`,width:`${l.width}%`,minHeight:`${l.height}%`}} key={l.id}>{editing?<textarea value={l.text} onChange={e=>setLettering(v=>v.map((x,n)=>n===i?{...x,text:e.target.value}:x))}/>:<><small>{l.speaker}</small>{l.text}</>}</div>)}</div><div className="page-meta"><span>Page {page.pageNumber} · revision {page.revision}</span>{editing?<button onClick={()=>void save()}>Save text</button>:<button onClick={()=>setEditing(true)}>Edit lettering</button>}</div></article>;
}

function Settings(){const [settings,setSettings]=useState<any>();useEffect(()=>{void api("/api/settings").then(setSettings)},[]);return <><SectionHead kicker="LOCAL & PRIVATE BY DEFAULT" title="Provider and storage settings" subtitle="Secrets stay server-side. This screen never exposes their values."/><div className="settings-list"><div><span>Provider</span><strong>{settings?.providerMode??"…"}</strong></div><div><span>API key</span><strong>{settings?.apiKeyConfigured?"Configured":"Not configured"}</strong></div><div><span>Paid calls</span><strong>{settings?.paidCallsEnabled?"Server enabled":"Disabled"}</strong></div><div><span>Per-job spending limit</span><strong>{settings?.maxJobSpendUsd?`$${settings.maxJobSpendUsd}`:"Not set"}</strong></div><div><span>Storage</span><code>{settings?.dataDir}</code></div></div><div className="privacy-note"><strong>External processing notice</strong><p>{settings?.privacy}</p><p>Mock mode makes no provider calls and uses clearly marked placeholder artwork. An API subscription is separate from any ChatGPT subscription.</p></div></>}
function SectionHead({kicker,title,subtitle}:{kicker:string;title:string;subtitle:string}){return <div className="section-head"><p className="eyebrow">{kicker}</p><h2>{title}</h2><p>{subtitle}</p></div>}
function Empty({text}:{text:string}){return <div className="empty"><span>＋</span><p>{text}</p></div>}
