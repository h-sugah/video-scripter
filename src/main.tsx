import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Project = { id: string; name: string; created_at: string; video_count: number };
type Video = { id: string; name: string; duration: number | null; sha256: string; created_at: string };
type Event = {
  id: string;
  start_time: number;
  end_time: number | null;
  event_type: string;
  description: string;
  objects_json: string;
  confidence: number | null;
  evidence_json: string;
};

type ProviderMeta = {
  id: 'lmstudio' | 'openai' | 'anthropic' | 'google';
  name: string;
  capabilities: {
    video_input: boolean;
    image_input: boolean;
    streaming: boolean;
  };
  defaultBaseUrl: string;
  defaultModel: string;
  popularModels: string[];
};

type ProfileMeta = {
  id: 'operation' | 'seminar_education' | 'situation' | 'meeting' | 'custom';
  name: string;
  description: string;
  icon: string;
  targetEventsDescription: string;
  defaultCustomPerceptionPrompt?: string;
  defaultCustomReportPrompt?: string;
};

// LAN公開モードで401(未認証)を受け取った際に呼び出されるコールバック。
// App側でuseEffectを通じて登録し、ログイン画面への切り替えに使う。
let onUnauthorized: (() => void) | null = null;

const api = async (path: string, init?: RequestInit) => {
  const headers = { ...(init?.headers as Record<string, string> | undefined), 'X-Requested-With': 'video-scripter' };
  const r = await fetch('/api' + path, { ...init, headers });
  if (r.status === 401) {
    onUnauthorized?.();
    throw new Error('LAN経由でのアクセスには認証が必要です。');
  }
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

  // 設定関連
  const [providersMeta, setProvidersMeta] = useState<ProviderMeta[]>([]);
  const [profilesMeta, setProfilesMeta] = useState<ProfileMeta[]>([]);
  const [activeProvider, setActiveProvider] = useState<'lmstudio' | 'openai' | 'anthropic' | 'google'>('lmstudio');
  const [activeProfile, setActiveProfile] = useState<'operation' | 'seminar_education' | 'situation' | 'meeting' | 'custom'>('operation');
  const [customPerceptionPrompt, setCustomPerceptionPrompt] = useState('');
  const [customReportPrompt, setCustomReportPrompt] = useState('');
  const [videoAnalysisMode, setVideoAnalysisMode] = useState<'auto' | 'direct' | 'frames'>('auto');

  // プロバイダー設定フォーム用ステート
  const [providerSettings, setProviderSettings] = useState<Record<string, { url: string; model: string; token: string; configured: boolean; clear_token?: boolean }>>({
    lmstudio: { url: 'http://127.0.0.1:1234/v1', model: '', token: '', configured: false },
    openai: { url: 'https://api.openai.com/v1', model: '', token: '', configured: false },
    anthropic: { url: 'https://api.anthropic.com/v1', model: '', token: '', configured: false },
    google: { url: 'https://generativelanguage.googleapis.com', model: '', token: '', configured: false },
  });

  // 設定モーダル内の選択タブ
  const [settingsTab, setSettingsTab] = useState<'providers' | 'profiles'>('providers');
  const [selectedProviderInSettings, setSelectedProviderInSettings] = useState<'lmstudio' | 'openai' | 'anthropic' | 'google'>('lmstudio');
  const [providerModelLists, setProviderModelLists] = useState<Record<string, string[]>>({});
  const [isTestingConnection, setIsTestingConnection] = useState(false);

  // 解析画面でのプロファイル・プロバイダー即時切り替え
  const [executionProfile, setExecutionProfile] = useState<'operation' | 'seminar_education' | 'situation' | 'meeting' | 'custom'>('operation');
  const [executionProvider, setExecutionProvider] = useState<'lmstudio' | 'openai' | 'anthropic' | 'google'>('lmstudio');
  const [showCustomPromptEditor, setShowCustomPromptEditor] = useState(false);

  const [message, setMessage] = useState('');
  const [job, setJob] = useState<any>();
  const [report, setReport] = useState<any>();
  const [showSettings, setShowSettings] = useState(false);
  // 再開用に最後の解析オプションを保持
  const [lastAnalyzeOptions, setLastAnalyzeOptions] = useState<any>(null);

  // LAN公開モード: 未認証(401)を検知したらログイン画面に切り替える
  const [needsLanAuth, setNeedsLanAuth] = useState(false);
  const [lanAuthToken, setLanAuthToken] = useState('');
  const [lanAuthError, setLanAuthError] = useState('');
  const [lanAuthSubmitting, setLanAuthSubmitting] = useState(false);

  const activeStreamRef = useRef<EventSource | null>(null);

  const current = useMemo(() => videos.find(v => v.id === videoId), [videos, videoId]);

  const refreshProjects = useCallback(() => api('/projects').then(setProjects).catch(e => setMessage(e.message)), []);

  const loadSettings = useCallback(async () => {
    try {
      const data = await api('/settings');
      if (data.providers_meta) setProvidersMeta(data.providers_meta);
      if (data.profiles) setProfilesMeta(data.profiles);
      if (data.active_provider) {
        setActiveProvider(data.active_provider);
        setExecutionProvider(data.active_provider);
        setSelectedProviderInSettings(data.active_provider);
      }
      if (data.active_profile) {
        setActiveProfile(data.active_profile);
        setExecutionProfile(data.active_profile);
      }
      if (data.custom_perception_prompt != null) setCustomPerceptionPrompt(data.custom_perception_prompt);
      if (data.custom_report_prompt != null) setCustomReportPrompt(data.custom_report_prompt);
      if (data.video_analysis_mode) setVideoAnalysisMode(data.video_analysis_mode);

      if (data.provider_settings) {
        setProviderSettings(prev => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(data.provider_settings) as [string, any][]) {
            next[k] = {
              url: v.url ?? prev[k]?.url ?? '',
              model: v.model ?? prev[k]?.model ?? '',
              token: '',
              configured: Boolean(v.configured),
            };
          }
          return next;
        });
      }
    } catch {}
  }, []);

  useEffect(() => {
    onUnauthorized = () => setNeedsLanAuth(true);
    return () => { onUnauthorized = null; };
  }, []);

  const submitLanAuthToken = async () => {
    if (!lanAuthToken.trim()) return;
    setLanAuthSubmitting(true);
    setLanAuthError('');
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'video-scripter' },
        body: JSON.stringify({ token: lanAuthToken.trim() }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setLanAuthError(j.error || `ログインに失敗しました (${r.status})`);
        return;
      }
      setNeedsLanAuth(false);
      setLanAuthToken('');
      window.location.reload();
    } catch (e: any) {
      setLanAuthError(e.message || 'ログインに失敗しました');
    } finally {
      setLanAuthSubmitting(false);
    }
  };

  useEffect(() => {
    refreshProjects();
    api('/health').then(setHealth).catch(() => {});
    loadSettings();

    return () => {
      if (activeStreamRef.current) {
        activeStreamRef.current.close();
        activeStreamRef.current = null;
      }
    };
  }, [refreshProjects, loadSettings]);

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
        if (['completed', 'failed', 'cancelled', 'paused'].includes(next.status)) {
          closeStream();
          if (next.status === 'completed') {
            const isReportJob = next.type === 'report' || (typeof next.message === 'string' && (next.message.includes('報告書') || next.message.includes('記録') || next.message.includes('議事録')));
            openVideo(targetVideoId, isReportJob);
          } else if (next.status === 'paused') {
            // 中断時に抽出済みのイベントがあれば画面に反映
            openVideo(targetVideoId);
          }
        }
      } catch {}
    };

    stream.onerror = () => {
      // 自動再接続待機
    };
  }, [closeStream, openVideo]);

  const pauseJob = async () => {
    if (!job?.id) return;
    try {
      setMessage('解析を中断しています...');
      await api(`/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'paused' }),
      });
    } catch (e: any) {
      setMessage(e.message);
    }
  };

  const cancelJob = async () => {
    if (!job?.id) return;
    const isReport = job?.type === 'report' || (typeof job?.message === 'string' && (job.message.includes('報告書') || job.message.includes('記録') || job.message.includes('議事録')));
    try {
      setMessage(isReport ? '報告書生成をキャンセルしています...' : '解析をキャンセルしています...');
      await api(`/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      });
    } catch (e: any) {
      setMessage(e.message);
    }
  };

  const resumeJob = async () => {
    if (!job?.id || !videoId) return;
    try {
      setMessage('解析を再開しています...');
      const j = await api(`/jobs/${job.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: executionProvider,
          profileId: executionProfile,
          customPerceptionPrompt: executionProfile === 'custom' ? customPerceptionPrompt : undefined,
          mode: videoAnalysisMode,
        }),
      });
      setJob(j);
      subscribeJob(j.id, videoId);
    } catch (e: any) {
      setMessage(e.message);
    }
  };

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

  const deleteProject = async (p: Project) => {
    const ok = window.confirm(
      `プロジェクト「${p.name}」を削除しますか？\n含まれる動画${p.video_count}本・解析イベント・報告書もすべて完全に削除されます。この操作は取り消せません。`
    );
    if (!ok) return;
    try {
      await api('/projects/' + p.id, { method: 'DELETE' });
      if (selected === p.id) {
        closeStream();
        setSelected(undefined);
        setVideoId(undefined);
        setVideos([]);
        setEvents([]);
        setJob(undefined);
      }
      await refreshProjects();
      setMessage(`プロジェクト「${p.name}」を削除しました。`);
    } catch (e: any) {
      setMessage(e.message);
    }
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
      setMessage(`[${executionProfile}] 解析を開始しました…`);
      const j = await api('/videos/' + videoId + '/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: executionProvider,
          profileId: executionProfile,
          customPerceptionPrompt: executionProfile === 'custom' ? customPerceptionPrompt : undefined,
          mode: videoAnalysisMode,
        }),
      });
      setJob(j);
      subscribeJob(j.id, videoId);
    } catch (e: any) {
      setMessage(e.message);
    }
  };

  const createReport = async () => {
    if (!videoId) return;
    try {
      setMessage(`[${executionProfile}] 報告書の生成を開始しました…`);
      const j = await api('/videos/' + videoId + '/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: executionProvider,
          profileId: executionProfile,
          customReportPrompt: executionProfile === 'custom' ? customReportPrompt : undefined,
        }),
      });
      setJob(j);
      subscribeJob(j.id, videoId);
    } catch (e: any) {
      setMessage(e.message);
    }
  };

  const openReport = async (reportId: string) => {
    try {
      setMessage('報告書を読み込んでいます…');
      const fullReport = await api('/reports/' + reportId);
      setReport(fullReport);
      setMessage('');
    } catch (e: any) {
      setMessage(`報告書の取得に失敗しました: ${e.message}`);
    }
  };

  const downloadReport = (targetReport?: any) => {
    const r = targetReport || report;
    if (!r || !r.markdown) return;
    const safeName = String(r.title || '作業報告書').replace(/[\\/:*?"<>|]/g, '_');
    const url = URL.createObjectURL(new Blob([r.markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName}.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setMessage(`「${safeName}.md」をダウンロードしました。`);
  };

  const downloadReportById = async (e: React.MouseEvent, reportId: string) => {
    e.stopPropagation();
    try {
      setMessage('報告書データを取得中…');
      const fullReport = await api('/reports/' + reportId);
      downloadReport(fullReport);
    } catch (e: any) {
      setMessage(`ダウンロードに失敗しました: ${e.message}`);
    }
  };

  const copyReportToClipboard = async () => {
    if (!report?.markdown) return;
    try {
      await navigator.clipboard.writeText(report.markdown);
      setMessage('報告書のテキストをクリップボードにコピーしました。');
    } catch {
      setMessage('コピーに失敗しました。');
    }
  };

  const testProviderConnection = async (providerId: string, silent = false) => {
    setIsTestingConnection(true);
    try {
      if (!silent) setMessage(`${providerId.toUpperCase()} へ接続テスト中…`);
      const pSetting = providerSettings[providerId] || {};
      const result = await api(`/providers/${providerId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: pSetting.url,
          token: pSetting.token,
          model: pSetting.model,
        }),
      });

      if (result.models && result.models.length > 0) {
        setProviderModelLists(prev => ({ ...prev, [providerId]: result.models }));
        if (!pSetting.model || !result.models.includes(pSetting.model)) {
          setProviderSettings(prev => ({
            ...prev,
            [providerId]: { ...prev[providerId], model: result.models[0] },
          }));
        }
        if (!silent) setMessage(`接続成功: ${result.models.length}件の利用可能モデルを取得しました。`);
      } else {
        if (!silent) setMessage('接続に成功しました。');
      }
    } catch (e: any) {
      if (!silent) setMessage(`接続失敗: ${e.message}`);
    } finally {
      setIsTestingConnection(false);
    }
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload: any = {
        active_provider: activeProvider,
        active_profile: activeProfile,
        custom_perception_prompt: customPerceptionPrompt,
        custom_report_prompt: customReportPrompt,
        video_analysis_mode: videoAnalysisMode,
        provider_settings: providerSettings,
      };

      await api('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      setExecutionProvider(activeProvider);
      setExecutionProfile(activeProfile);
      setShowSettings(false);
      setMessage('設定を保存しました。');
      await loadSettings();
    } catch (e: any) {
      setMessage(e.message);
    }
  };

  const openSettingsModal = async () => {
    setShowSettings(true);
    await loadSettings();
    void testProviderConnection(selectedProviderInSettings, true);
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
  const isPaused = job?.status === 'paused';
  const isReportJob = job?.type === 'report' || (typeof job?.message === 'string' && (job.message.includes('報告書') || job.message.includes('記録') || job.message.includes('議事録')));
  const isAnalyzeJob = !isReportJob;
  const activeProfileDef = profilesMeta.find(p => p.id === executionProfile) || profilesMeta[0];
  const activeProviderDef = providersMeta.find(p => p.id === executionProvider) || providersMeta[0];

  if (needsLanAuth) {
    return (
      <main className="lan-auth-gate">
        <div className="lan-auth-card">
          <h1>▶ Video Scripter</h1>
          <p>LAN経由でのアクセスには認証トークンが必要です。</p>
          <p className="hint">トークンは本体PCのコンソール、または <code>data/lan-auth-token</code> ファイルで確認できます。</p>
          <input
            type="password"
            autoFocus
            placeholder="アクセストークンを入力"
            value={lanAuthToken}
            onChange={e => setLanAuthToken(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitLanAuthToken(); }}
          />
          {lanAuthError && <p className="lan-auth-error">{lanAuthError}</p>}
          <button className="primary full" disabled={lanAuthSubmitting || !lanAuthToken.trim()} onClick={submitLanAuthToken}>
            {lanAuthSubmitting ? '確認中…' : 'ログイン'}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main>
      <header>
        <div>
          <span className="mark">▶</span>
          <strong>Video Scripter</strong>
          <small> 根拠を残すマルチプロバイダー映像分析</small>
        </div>
        <div className="status">
          {health?.ffmpeg && health?.ffprobe ? (
            <span className="ready">● FFmpeg / ffprobe稼働中</span>
          ) : (
            <span className="danger">
              ● {!health?.ffmpeg && !health?.ffprobe ? 'FFmpeg / ffprobe未検出' : !health?.ffmpeg ? 'FFmpeg未検出' : 'ffprobe未検出'}
            </span>
          )}
          <button className="ghost" onClick={openSettingsModal}>⚙ 設定・プロファイル</button>
        </div>
      </header>

      <div className="layout">
        <aside>
          <button className="primary full" onClick={newProject}>＋ 新しいプロジェクト</button>
          <h3>プロジェクト</h3>
          {projects.length === 0 && <p className="muted">プロジェクトを作成して動画を追加します。</p>}
          {projects.map(p => (
            <div key={p.id} className="project-row">
              <button className={'project ' + (selected === p.id ? 'active' : '')} onClick={() => openProject(p.id)}>
                <b>{p.name}</b>
                <small>{p.video_count} 本の動画</small>
              </button>
              <button
                className="project-delete"
                title="プロジェクトを削除"
                onClick={e => { e.stopPropagation(); deleteProject(p); }}
              >
                ✕
              </button>
            </div>
          ))}

          <hr />
          <h3>AI プロバイダー</h3>
          <div className="provider-status-list">
            {providersMeta.map(p => {
              const isCurrent = executionProvider === p.id;
              const hasConfig = p.id === 'lmstudio' ? true : providerSettings[p.id]?.configured;
              return (
                <div
                  key={p.id}
                  className={`provider-chip ${isCurrent ? 'active' : ''}`}
                  onClick={() => {
                    setExecutionProvider(p.id);
                    setActiveProvider(p.id);
                  }}
                  title={p.capabilities.video_input ? '動画直接入力 & 画像入力対応' : '画像入力対応'}
                >
                  <div className="p-header">
                    <span className={hasConfig || p.id === 'lmstudio' ? 'dot-ready' : 'dot-unconfigured'}>●</span>
                    <b>{p.id === 'lmstudio' ? 'LM Studio' : p.name.replace(/\s*\(.*/, '')}</b>
                    {isCurrent && <span className="badge-active">選択中</span>}
                  </div>
                  <div className="p-caps">
                    {p.capabilities.video_input ? (
                      <span className="cap video">動画直接+画像</span>
                    ) : (
                      <span className="cap image">画像フレーム</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <hr />
          <h3>解析プロファイル</h3>
          <div className="profile-selector-sidebar">
            {profilesMeta.map(pr => (
              <button
                key={pr.id}
                className={`profile-btn ${executionProfile === pr.id ? 'active' : ''}`}
                onClick={() => {
                  setExecutionProfile(pr.id);
                  setActiveProfile(pr.id);
                }}
              >
                <span className="p-icon">{pr.icon}</span>
                <span className="p-title">{pr.name}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="content">
          {!selected ? (
            <div className="empty">
              <h1>映像を、検証できる構造化記録へ。</h1>
              <p>プロジェクトを作成し、作業動画や講義・定点カメラ・現地の映像をアップロードしてください。</p>
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
                  {isWorking ? (
                    isAnalyzeJob ? (
                      <>
                        <button onClick={pauseJob} className="pause-btn" title="解析を一時中断します（後から続きを再開できます）">⏸ 中断</button>
                        <button onClick={cancelJob} className="cancel-btn" title="解析を完全に中止します">⏹ キャンセル</button>
                      </>
                    ) : (
                      <button onClick={cancelJob} className="cancel-btn" title="報告書生成を中止します">⏹ キャンセル</button>
                    )
                  ) : isPaused ? (
                    <>
                      <button onClick={resumeJob} className="primary resume-btn" title="中断した箇所から解析を再開します">▶ 解析を再開</button>
                      <button onClick={analyze} className="secondary" title="最初から新しく解析を実行します">✦ 最初から再解析</button>
                      <button onClick={cancelJob} className="cancel-btn" title="中断状態を破棄してキャンセルにします">⏹ キャンセル</button>
                    </>
                  ) : (
                    <>
                      <button onClick={analyze} className="primary">✦ 解析開始</button>
                      <button onClick={createReport} disabled={!events.length}>報告書・記録を生成</button>
                      <button className="delete" onClick={deleteVideo}>削除</button>
                    </>
                  )}
                </div>
              </div>

              {/* プロファイル & プロバイダー即時選択コントロールバー */}
              <div className="control-bar">
                <div className="control-group">
                  <label>解析プロファイル:</label>
                  <select
                    value={executionProfile}
                    onChange={e => setExecutionProfile(e.target.value as any)}
                    disabled={isWorking}
                  >
                    {profilesMeta.map(p => (
                      <option key={p.id} value={p.id}>{p.icon} {p.name}</option>
                    ))}
                  </select>
                </div>

                <div className="control-group">
                  <label>AIプロバイダー:</label>
                  <select
                    value={executionProvider}
                    onChange={e => setExecutionProvider(e.target.value as any)}
                    disabled={isWorking}
                  >
                    {providersMeta.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>

                {activeProviderDef?.capabilities.video_input && (
                  <div className="control-group">
                    <label>動画入力方式:</label>
                    <select
                      value={videoAnalysisMode}
                      onChange={e => setVideoAnalysisMode(e.target.value as any)}
                      disabled={isWorking}
                    >
                      <option value="auto">自動 (Gemini File API直接送信)</option>
                      <option value="direct">動画直接送信 (Gemini Video)</option>
                      <option value="frames">フレーム抽出方式 (画像バッチ)</option>
                    </select>
                  </div>
                )}

                {executionProfile === 'custom' && (
                  <button
                    className="ghost toggle-custom-btn"
                    onClick={() => setShowCustomPromptEditor(!showCustomPromptEditor)}
                  >
                    {showCustomPromptEditor ? '▲ カスタム指示を隠す' : '▼ カスタム指示を編集'}
                  </button>
                )}
              </div>

              {/* カスタムプロファイルのプロンプト編集フォーム */}
              {executionProfile === 'custom' && showCustomPromptEditor && (
                <div className="custom-prompt-panel">
                  <div className="field">
                    <label>【カスタム】映像解析・イベント抽出の観点指示:</label>
                    <textarea
                      rows={3}
                      placeholder="例: 作業者の手の動きと使用した機器、工具のみを抽出してください。"
                      value={customPerceptionPrompt}
                      onChange={e => setCustomPerceptionPrompt(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>【カスタム】報告書・記録の構成要件指示:</label>
                    <textarea
                      rows={3}
                      placeholder="例: 見出し構成を「概要」「時系列手順」「留意事項」とし、箇条書きで出力してください。"
                      value={customReportPrompt}
                      onChange={e => setCustomReportPrompt(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {job && (
                <div className={'job ' + job.status}>
                  <div className="job-header">
                    <div className="job-info">
                      <b className={`status-tag status-${job.status}`}>
                        {job.status === 'completed' ? '✓ 完了' :
                         job.status === 'failed' ? '⚠ 失敗' :
                         job.status === 'paused' ? '⏸ 中断中' :
                         job.status === 'cancelled' ? '⏹ キャンセル' :
                         isReportJob ? '📄 報告書生成中' : '🔍 解析中'}
                      </b>
                      <span className="job-message">{job.message}</span>
                    </div>
                    <div className="job-actions">
                      {isWorking && isAnalyzeJob && (
                        <>
                          <button type="button" className="job-action-btn pause" onClick={pauseJob} title="解析を一時中断">⏸ 中断</button>
                          <button type="button" className="job-action-btn cancel" onClick={cancelJob} title="解析を中止">⏹ キャンセル</button>
                        </>
                      )}
                      {isWorking && isReportJob && (
                        <button type="button" className="job-action-btn cancel" onClick={cancelJob} title="報告書生成を中止">⏹ キャンセル</button>
                      )}
                      {isPaused && (
                        <>
                          <button type="button" className="job-action-btn resume" onClick={resumeJob} title="中断した箇所から再開">▶ 解析を再開</button>
                          <button type="button" className="job-action-btn cancel" onClick={cancelJob} title="中断状態を破棄">⏹ 破棄</button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="progress">
                    <i style={{ width: `${job.progress}%` }} />
                  </div>
                </div>
              )}

              <div className="work">
                <div className="timeline">
                  <div className="panel-head">
                    <h2>時系列イベント（{activeProfileDef?.name || '解析結果'}）</h2>
                    <span>{events.length} 件</span>
                  </div>
                  {events.length === 0 ? (
                    <div className="empty small">
                      「✦ 解析開始」をクリックすると、選択したプロファイルとAIプロバイダーで根拠付きイベントが抽出されます。
                    </div>
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
                              {objects.length > 0 ? (
                                <span className="objects-tags">
                                  {objects.map((obj: string, i: number) => (
                                    <span key={i} className="tag">{obj}</span>
                                  ))}
                                </span>
                              ) : (
                                <span className="tag type-tag">{e.event_type}</span>
                              )}
                              <span className="conf">信頼度 {Math.round((e.confidence || 0) * 100)}%</span>
                            </p>
                            {ev.frame && (
                              <a href={'/media/' + ev.frame} target="_blank" rel="noreferrer">
                                根拠フレーム #{ev.frame_index} を表示
                              </a>
                            )}
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
                  <p>各イベントは、動画ハッシュ・モデル・抽出フレーム・推定時刻と結び付けて監査ログに保存されます。</p>
                  <dl>
                    <dt>映像ファイル</dt>
                    <dd>{current?.name}</dd>
                    <dt>解析プロファイル</dt>
                    <dd>{activeProfileDef?.icon} {activeProfileDef?.name}</dd>
                    <dt>使用AIプロバイダー</dt>
                    <dd>{activeProviderDef?.name} ({providerSettings[executionProvider]?.model || activeProviderDef?.defaultModel || 'デフォルト'})</dd>
                    <dt>入力Capability</dt>
                    <dd>{activeProviderDef?.capabilities.video_input ? '動画直接入力 (Gemini)' : '画像フレームバッチ'}</dd>
                    <dt>証跡フレーム</dt>
                    <dd>イベントのリンクから常時検証可能</dd>
                  </dl>
                </div>
              </div>

              {reports.length > 0 && (
                <div className="reports">
                  <div className="panel-head">
                    <h2>生成された報告書・記録</h2>
                    <span>{reports.length} 件</span>
                  </div>
                  <div className="reports-list">
                    {reports.map(r => (
                      <div key={r.id} className="report-item-card" onClick={() => openReport(r.id)} title="クリックして報告書をプレビュー">
                        <div className="report-item-info">
                          <span className="report-icon">📄</span>
                          <div className="report-item-texts">
                            <b className="report-title">{r.title}</b>
                            <small className="report-date">{new Date(r.created_at).toLocaleString()}</small>
                          </div>
                        </div>
                        <div className="report-item-actions">
                          <button
                            type="button"
                            className="report-download-btn"
                            onClick={(e) => downloadReportById(e, r.id)}
                            title="Markdownファイルをダウンロード"
                          >
                            ↓ ダウンロード
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {message && <div className="toast" onClick={() => setMessage('')}>{message}</div>}

      {/* 報告書表示モーダル */}
      {report && (
        <div className="modal" onClick={(e) => { if (e.target === e.currentTarget) setReport(null); }}>
          <div className="sheet report-preview-sheet">
            <button className="close" onClick={() => setReport(null)} title="閉じる">×</button>
            <h2>{report.title}</h2>
            <div className="modal-actions-bar">
              <button className="primary download" onClick={() => downloadReport(report)}>↓ Markdownをダウンロード</button>
              <button className="secondary copy" onClick={copyReportToClipboard}>📋 テキストをコピー</button>
            </div>
            <pre className="report-markdown-view">{report.markdown}</pre>
          </div>
        </div>
      )}

      {/* 設定・プロファイル管理モーダル */}
      {showSettings && (
        <div className="modal">
          <form className="sheet settings-modal" onSubmit={saveSettings}>
            <button type="button" className="close" onClick={() => setShowSettings(false)}>×</button>
            <h2>設定 & 解析プロファイル</h2>

            <div className="settings-tabs">
              <button
                type="button"
                className={`tab-btn ${settingsTab === 'providers' ? 'active' : ''}`}
                onClick={() => setSettingsTab('providers')}
              >
                🤖 AIプロバイダー設定
              </button>
              <button
                type="button"
                className={`tab-btn ${settingsTab === 'profiles' ? 'active' : ''}`}
                onClick={() => setSettingsTab('profiles')}
              >
                📋 解析プロファイル設定
              </button>
            </div>

            {settingsTab === 'providers' ? (
              <div className="provider-settings-section">
                <div className="provider-sub-tabs">
                  {providersMeta.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      className={`sub-tab-btn ${selectedProviderInSettings === p.id ? 'active' : ''}`}
                      onClick={() => {
                        setSelectedProviderInSettings(p.id);
                        void testProviderConnection(p.id, true);
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>

                {(() => {
                  const pid = selectedProviderInSettings;
                  const meta = providersMeta.find(p => p.id === pid);
                  const pConfig = providerSettings[pid] || { url: '', model: '', token: '', configured: false };
                  const modelList = providerModelLists[pid] || meta?.popularModels || [];

                  return (
                    <div className="provider-edit-pane">
                      <div className="cap-notice">
                        <strong>Capability: </strong>
                        {meta?.capabilities.video_input ? (
                          <span className="badge cap-video">🎬 動画直接入力 (video_input = true) & 画像入力 (image_input = true)</span>
                        ) : (
                          <span className="badge cap-image">🖼 画像フレーム入力 (video_input = false, image_input = true)</span>
                        )}
                        <span className="badge cap-stream">⚡ ストリーミング対応</span>
                      </div>

                      <label>
                        API エンドポイント URL
                        <input
                          value={pConfig.url}
                          onChange={e => setProviderSettings({
                            ...providerSettings,
                            [pid]: { ...pConfig, url: e.target.value },
                          })}
                          placeholder={meta?.defaultBaseUrl}
                        />
                      </label>

                      <label>
                        使用モデル
                        <div className="model-select-group">
                          <input
                            list={`models-list-${pid}`}
                            value={pConfig.model}
                            onChange={e => setProviderSettings({
                              ...providerSettings,
                              [pid]: { ...pConfig, model: e.target.value },
                            })}
                            placeholder="モデル名を入力または選択"
                          />
                          <datalist id={`models-list-${pid}`}>
                            {modelList.map(m => (
                              <option key={m} value={m} />
                            ))}
                          </datalist>
                        </div>
                      </label>

                      <label>
                        API トークン / API キー
                        <input
                          type="password"
                          placeholder={pConfig.configured ? '設定済み（変更する場合のみ入力）' : `${meta?.name} のAPIキー / トークン`}
                          value={pConfig.token}
                          onChange={e => setProviderSettings({
                            ...providerSettings,
                            [pid]: { ...pConfig, token: e.target.value },
                          })}
                        />
                      </label>

                      {pConfig.configured && (
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={Boolean(pConfig.clear_token)}
                            onChange={e => setProviderSettings({
                              ...providerSettings,
                              [pid]: { ...pConfig, clear_token: e.target.checked },
                            })}
                          />
                          保存済みAPIキー/トークンを削除する
                        </label>
                      )}

                      <div className="provider-actions">
                        <button
                          type="button"
                          disabled={isTestingConnection}
                          onClick={() => testProviderConnection(pid, false)}
                        >
                          {isTestingConnection ? '接続確認中…' : '🔄 接続を確認・モデル一覧を取得'}
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </div>
            ) : (
              <div className="profile-settings-section">
                <div className="profile-cards-grid">
                  {profilesMeta.map(pr => (
                    <div
                      key={pr.id}
                      className={`profile-card ${activeProfile === pr.id ? 'selected' : ''}`}
                      onClick={() => setActiveProfile(pr.id)}
                    >
                      <div className="card-top">
                        <span className="icon">{pr.icon}</span>
                        <b>{pr.name}</b>
                        {activeProfile === pr.id && <span className="default-badge">デフォルト</span>}
                      </div>
                      <p className="card-desc">{pr.description}</p>
                      <div className="card-target">
                        <small>抽出対象: {pr.targetEventsDescription}</small>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="custom-profile-fields">
                  <h3>カスタムプロファイルのデフォルト指示</h3>
                  <label>
                    カスタム解析観点プロンプト（映像から何を抽出するか）
                    <textarea
                      rows={3}
                      value={customPerceptionPrompt}
                      onChange={e => setCustomPerceptionPrompt(e.target.value)}
                      placeholder="例: 作業者の手順と使用した器具、状態変化を時系列で抽出してください。"
                    />
                  </label>
                  <label>
                    カスタム報告書構成プロンプト（どのようなレポートを作成するか）
                    <textarea
                      rows={3}
                      value={customReportPrompt}
                      onChange={e => setCustomReportPrompt(e.target.value)}
                      placeholder="例: 「概要」「作業詳細」「改善提案」の見出しで整理してください。"
                    />
                  </label>
                </div>
              </div>
            )}

            <div className="setting-actions">
              <button type="button" onClick={() => setShowSettings(false)}>キャンセル</button>
              <button className="primary" type="submit">設定を保存</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
