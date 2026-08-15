import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Project = { id: string; name: string; created_at: string; video_count: number };
type Video = { id: string; name: string; duration: number | null; sha256: string; created_at: string };
type Event = { id: string; start_time: number; end_time: number | null; event_type: string; description: string; objects_json: string; confidence: number | null; evidence_json: string };

const api = async (path: string, init?: RequestInit) => {
  const r = await fetch('/api' + path, init);
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `通信エラー (${r.status})`);
  }
  return r.status === 204 ? null : r.json();
};

const time = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string>();
  const [videos, setVideos] = useState<Video[]>([]);
  const [videoId, setVideoId] = useState<string>();
  const [events, setEvents] = useState<Event[]>([]);
  const [reports, setReports] = useState<any[]>([]);
  const [health, setHealth] = useState<any>();
  const [settings, setSettings] = useState({
    lmstudio_url: '',
    lmstudio_model: '',
    lmstudio_token: '',
    lmstudio_token_configured: false,
    clear_lmstudio_token: false,
  });
  const [models, setModels] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [job, setJob] = useState<any>();
  const [report, setReport] = useState<any>();
  const [showSettings, setShowSettings] = useState(false);

  const activeStreamRef = useRef<EventSource | null>(null);

  const current = useMemo(() => videos.find(v => v.id === videoId), [videos, videoId]);

  const refreshProjects = useCallback(() => api('/projects').then(setProjects).catch(e => setMessage(e.message)), []);

  useEffect(() => {
    refreshProjects();
    api('/health').then(setHealth).catch(() => {});
    api('/settings').then(setSettings).catch(() => {});

    return () => {
      if (activeStreamRef.current) {
        activeStreamRef.current.close();
        activeStreamRef.current = null;
      }
    };
  }, [refreshProjects]);

  const closeStream = useCallback(() => {
    if (activeStreamRef.current) {
      activeStreamRef.current.close();
      activeStreamRef.current = null;
    }
  }, []);

  const openVideo = useCallback(async (id: string, autoOpenLatestReport = false) => {
    setVideoId(id);
    const d = await api('/videos/' + id);
    setEvents(d.events);
    setReports(d.reports);
    const latestJob = d.jobs?.[0];
    setJob(latestJob);

    if (autoOpenLatestReport && d.reports?.[0]) {
      const fullReport = await api('/reports/' + d.reports[0].id);
      setReport(fullReport);
    }

    if (latestJob && ['queued', 'running'].includes(latestJob.status)) {
      subscribeJob(latestJob.id, id);
    } else {
      closeStream();
    }
  }, [closeStream]);

  const subscribeJob = useCallback((targetJobId: string, targetVideoId: string) => {
    closeStream();
    const stream = new EventSource('/api/jobs/' + targetJobId + '/stream');
    activeStreamRef.current = stream;

    stream.onmessage = (e) => {
      try {
        const next = JSON.parse(e.data);
        setJob(next);
        if (['completed', 'failed'].includes(next.status)) {
          closeStream();
          if (next.status === 'completed') {
            const isReportJob = typeof next.message === 'string' && next.message.includes('報告書');
            openVideo(targetVideoId, isReportJob);
          }
        }
      } catch {}
    };

    stream.onerror = () => {
      // EventSource は自動再接続を試行するため何もしない
    };
  }, [closeStream, openVideo]);

  const openProject = async (id: string) => {
    closeStream();
    setSelected(id);
    setVideoId(undefined);
    setEvents([]);
    setJob(undefined);
    const d = await api('/projects/' + id);
    setVideos(d.videos);
  };

  const newProject = async () => {
    const name = prompt('プロジェクト名を入力してください');
    if (!name?.trim()) return;
    const p = await api('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    await refreshProjects();
    openProject(p.id);
  };

  const upload = async (file: File) => {
    if (!selected) return;
    setMessage('動画をアップロードしています…');
    const fd = new FormData();
    fd.append('video', file);
    try {
      const v = await api('/projects/' + selected + '/videos', { method: 'POST', body: fd });
      await openProject(selected);
      await openVideo(v.id);
      setMessage('アップロードしました。');
    } catch (e: any) {
      setMessage(e.message);
    }
  };

  const analyze = async () => {
    if (!videoId) return;
    try {
      const j = await api('/videos/' + videoId + '/analyze', { method: 'POST' });
      setJob(j);
      setMessage('解析を開始しました。');
      subscribeJob(j.id, videoId);
    } catch (e: any) {
      setMessage(e.message);
    }
  };

  const createReport = async () => {
    if (!videoId) return;
    try {
      setMessage('報告書の生成を開始しました…');
      const j = await api('/videos/' + videoId + '/report', { method: 'POST' });
      setJob(j);
      subscribeJob(j.id, videoId);
    } catch (e: any) {
      setMessage(e.message);
    }
  };

  const downloadReport = () => {
    if (!report) return;
    const safeName = String(report.title || '作業報告書').replace(/[\\/:*?"<>|]/g, '_');
    const url = URL.createObjectURL(new Blob([report.markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const testConnection = async (silent = false) => {
    try {
      if (!silent) setMessage('LM Studioへ接続しています…');
      const result = await api('/lmstudio/test', { method: 'POST' });
      setModels(result.models);
      if (!settings.lmstudio_model && result.models[0]) {
        setSettings(current => ({ ...current, lmstudio_model: result.models[0] }));
      }
      if (!silent) setMessage(`接続に成功しました。${result.models.length}件のモデルを取得しました。Vision対応モデルを選択して保存してください。`);
    } catch (e: any) {
      if (!silent) setMessage(e.message);
    }
  };

  const openSettings = async () => {
    setShowSettings(true);
    await testConnection(true);
  };

  const deleteVideo = async () => {
    if (!videoId || !current || !confirm(`「${current.name}」を削除します。動画、抽出フレーム、イベント、報告書も完全に削除されます。`)) return;
    try {
      closeStream();
      await api('/videos/' + videoId, { method: 'DELETE' });
      setMessage('動画と関連データを削除しました。');
      setVideoId(undefined);
      setEvents([]);
      setReports([]);
      setJob(undefined);
      if (selected) await openProject(selected);
      await refreshProjects();
    } catch (e: any) {
      setMessage(e.message);
    }
  };

  const isWorking = job?.status === 'running' || job?.status === 'queued';

  return (
    <main>
      <header>
        <div>
          <span className="mark">▶</span>
          <strong>Video Scripter</strong>
          <small> 根拠を残す作業映像分析</small>
        </div>
        <div className="status">
          {health?.ffmpeg ? <span>● FFmpeg</span> : <span className="danger">● FFmpeg未検出</span>}
          <button className="ghost" onClick={openSettings}>⚙ 設定</button>
        </div>
      </header>

      <div className="layout">
        <aside>
          <button className="primary full" onClick={newProject}>＋ 新しいプロジェクト</button>
          <h3>プロジェクト</h3>
          {projects.length === 0 && <p className="muted">プロジェクトを作成して動画を追加します。</p>}
          {projects.map(p => (
            <button key={p.id} className={'project ' + (selected === p.id ? 'active' : '')} onClick={() => openProject(p.id)}>
              <b>{p.name}</b>
              <small>{p.video_count} 本の動画</small>
            </button>
          ))}
          <hr />
          <h3>AIプロバイダー</h3>
          <div className="providers">
            <span className="ready">● LM Studio <small>実動</small></span>
            <span>○ Gemini <small>＜将来実装予定＞</small></span>
            <span>○ OpenAI <small>＜将来実装予定＞</small></span>
            <span>○ Anthropic <small>＜将来実装予定＞</small></span>
          </div>
        </aside>

        <section className="content">
          {!selected ? (
            <div className="empty">
              <h1>映像を、検証できる作業記録へ。</h1>
              <p>プロジェクトを作成し、作業動画をアップロードしてください。</p>
              <button className="primary" onClick={newProject}>プロジェクトを作成</button>
            </div>
          ) : !videoId ? (
            <>
              <div className="title">
                <div>
                  <h1>{projects.find(p => p.id === selected)?.name}</h1>
                  <p>動画を追加して解析を開始します。</p>
                </div>
                <label className="primary upload">
                  動画を追加
                  <input type="file" accept="video/*" onChange={e => e.target.files?.[0] && upload(e.target.files[0])} />
                </label>
              </div>
              <div className="cards">
                {videos.map(v => (
                  <button className="video-card" key={v.id} onClick={() => openVideo(v.id)}>
                    <span>🎬</span>
                    <b>{v.name}</b>
                    <small>{v.duration ? `${time(v.duration)} · ` : ''}SHA-256: {v.sha256.slice(0, 12)}…</small>
                  </button>
                ))}
                {videos.length === 0 && <div className="empty small">ここに動画を追加してください。</div>}
              </div>
            </>
          ) : (
            <>
              <div className="title">
                <div>
                  <button className="back" onClick={() => { closeStream(); setVideoId(undefined); }}>← 動画一覧</button>
                  <h1>{current?.name}</h1>
                  <p>動画ハッシュ: <code>{current?.sha256}</code></p>
                </div>
                <div className="actions">
                  <button onClick={analyze} className="primary" disabled={isWorking}>✦ 解析開始</button>
                  <button onClick={createReport} disabled={!events.length || isWorking}>報告書を生成</button>
                  <button className="delete" onClick={deleteVideo} disabled={isWorking}>削除</button>
                </div>
              </div>

              {job && (
                <div className={'job ' + job.status}>
                  <div>
                    <b>{job.status === 'completed' ? '完了' : job.status === 'failed' ? '失敗' : '処理中'}</b>
                    <span>{job.message}</span>
                  </div>
                  <div className="progress">
                    <i style={{ width: `${job.progress}%` }} />
                  </div>
                </div>
              )}

              <div className="work">
                <div className="timeline">
                  <div className="panel-head">
                    <h2>時系列イベント</h2>
                    <span>{events.length} 件</span>
                  </div>
                  {events.length === 0 ? (
                    <div className="empty small">解析を開始すると、根拠付きのイベントがここに表示されます。</div>
                  ) : (
                    events.map(e => {
                      const ev = JSON.parse(e.evidence_json || '{}');
                      const objects = JSON.parse(e.objects_json || '[]');
                      return (
                        <article className="event" key={e.id}>
                          <time>{time(e.start_time)}{e.end_time ? ` – ${time(e.end_time)}` : ''}</time>
                          <div>
                            <b>{e.description}</b>
                            <p>
                              {objects.join(' · ') || e.event_type}
                              <span>信頼度 {Math.round((e.confidence || 0) * 100)}%</span>
                            </p>
                            {ev.frame && <a href={'/media/' + ev.frame} target="_blank" rel="noreferrer">根拠フレーム #{ev.frame_index} を表示</a>}
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>

                <div className="evidence">
                  <div className="panel-head">
                    <h2>Evidence Chain</h2>
                  </div>
                  <p>各イベントは、動画ハッシュ・モデル設定・抽出フレーム・推定時刻と結び付けて保存されます。</p>
                  <dl>
                    <dt>映像</dt>
                    <dd>{current?.name}</dd>
                    <dt>フレーム</dt>
                    <dd>イベントのリンクから確認</dd>
                    <dt>音声</dt>
                    <dd>初期版では未解析</dd>
                    <dt>AI</dt>
                    <dd>LM Studio / {settings.lmstudio_model || '未選択'}</dd>
                  </dl>
                </div>
              </div>

              {reports.length > 0 && (
                <div className="reports">
                  <h2>報告書</h2>
                  {reports.map(r => (
                    <button key={r.id} onClick={async () => setReport(await api('/reports/' + r.id))}>
                      {r.title} <small>{new Date(r.created_at).toLocaleString()}</small>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {message && <div className="toast" onClick={() => setMessage('')}>{message}</div>}

      {report && (
        <div className="modal">
          <div className="sheet">
            <button className="close" onClick={() => setReport(null)}>×</button>
            <h2>{report.title}</h2>
            <button className="download" onClick={downloadReport}>↓ Markdownをダウンロード</button>
            <pre>{report.markdown}</pre>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="modal">
          <form
            className="sheet settings"
            onSubmit={async e => {
              e.preventDefault();
              await api('/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
              });
              setShowSettings(false);
              setMessage('設定を保存しました。');
            }}
          >
            <button type="button" className="close" onClick={() => setShowSettings(false)}>×</button>
            <h2>LM Studio 設定</h2>
            <label>
              サーバーURL
              <input value={settings.lmstudio_url} onChange={e => setSettings({ ...settings, lmstudio_url: e.target.value })} />
            </label>
            <label>
              Vision対応モデル
              <select required value={settings.lmstudio_model} onChange={e => setSettings({ ...settings, lmstudio_model: e.target.value })}>
                <option value="" disabled>
                  {models.length ? 'モデルを選択してください' : 'ロード済みモデルを取得中です…'}
                </option>
                {models.map(model => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            </label>
            <p className="hint model-count">LM Studioで取得したロード済みモデル: {models.length} 件</p>
            <label>
              APIトークン（必要な場合のみ）
              <input
                type="password"
                placeholder={settings.lmstudio_token_configured ? '設定済み（変更する場合のみ入力）' : 'LM StudioのAPIトークン'}
                value={settings.lmstudio_token}
                onChange={e => setSettings({ ...settings, lmstudio_token: e.target.value })}
              />
            </label>
            {settings.lmstudio_token_configured && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.clear_lmstudio_token}
                  onChange={e => setSettings({ ...settings, clear_lmstudio_token: e.target.checked })}
                />
                保存済みトークンを削除する
              </label>
            )}
            <p className="hint">
              設定画面を開くと、LM Studioのロード済みモデルを自動取得します。表示されないモデルは、LM Studio側でロードしてから「接続を確認」を押してください。テキスト専用モデルでは動画の内容を解析できません。
            </p>
            <div className="setting-actions">
              <button type="button" onClick={() => testConnection(false)}>接続を確認</button>
              <button className="primary">保存</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
