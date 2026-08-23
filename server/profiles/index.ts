import type {
  ProfileId,
  ProfileDefinition,
  BuildPerceptionPromptParams,
  BuildDirectVideoPromptParams,
  BuildReportPromptParams,
} from './types.js';

export * from './types.js';

export const PROFILES: Record<string, ProfileDefinition> = {
  operation: {
    id: 'operation',
    name: '作業・操作記録',
    description: '工場・現場作業、機械設備点検、PC/IT画面操作、組み立て・分解などの手順・動作・対象物・確認事項を記録します。',
    icon: '🔧',
    targetEventsDescription: '作業動作、使用工具・装置、操作対象、点検・測定値、安全確認、状態変化',
  },
  seminar_education: {
    id: 'seminar_education',
    name: 'セミナー・研修・教育記録',
    description: '講義、社内研修、技術セミナー、チュートリアル等のアジェンダ、スライド内容、実演・デモ、質疑応答を整理・記録します。',
    icon: '🎓',
    targetEventsDescription: '講義トピック、スライド提示、実演・デモ、質疑応答、重要ポイント',
  },
  situation: {
    id: 'situation',
    name: '状況記録',
    description: '映像の内容、状況、風景、環境、人物・物体の動きなどを記録し、全体の状況や概要を整理・記録します。',
    icon: '🏞️',
    targetEventsDescription: '情景・風景・環境、主要な被写体・人物、状況の変化、発生した事象、特記事項',
  },
  custom: {
    id: 'custom',
    name: 'カスタム',
    description: 'ユーザーが自由に指定した解析観点・指示や、独自の報告書フォーマットで処理します。',
    icon: '✨',
    targetEventsDescription: 'ユーザー指定のカスタム観点に基づき抽出',
    defaultCustomPerceptionPrompt: '映像内の重要な変化や動作を時系列順に客観的事実として抽出してください。',
    defaultCustomReportPrompt: '観測イベントをもとに、概要、時系列詳細、まとめ、根拠を含む包括的な記録を作成してください。',
  },
};

export function getAllProfiles(): ProfileDefinition[] {
  return [PROFILES.operation, PROFILES.seminar_education, PROFILES.situation, PROFILES.custom];
}

export function getProfile(id: ProfileId | string): ProfileDefinition {
  if (id === 'meeting') return PROFILES.situation;
  return PROFILES[id] ?? PROFILES.operation;
}

// フレーム画像バッチ用のイベント抽出プロンプト生成
export function buildPerceptionPrompt(params: BuildPerceptionPromptParams): string {
  const {
    profileId,
    duration,
    batchCount,
    batchStartIndex,
    batchEndIndex,
    batchStartTime,
    batchEndTime,
    interval,
    customPrompt,
  } = params;

  let roleInstruction = '';
  let eventTypeExamples = '';

  switch (profileId) {
    case 'operation':
      roleInstruction = `あなたは作業映像・機器操作映像の監査・記録担当です。
提示された画像から以下の事実を時系列順に客観的に抽出してください。
- 作業者の具体的な動作（触れる、開閉する、操作する、運ぶ、配線をつなぐ、ボタンを押す等）
- 使用している工具・機器・端末・UI画面・スイッチ・計器
- 操作対象物・部品・システム画面項目
- 目視点検・測定値確認・指差し呼称・安全確認
- 状態の変化や異常の兆候`;
      eventTypeExamples = `"operation"(操作), "inspection"(確認・点検), "setup"(準備・段取り), "cleanup"(片付け・復旧), "abnormal"(異常・注意), "other"`;
      break;

    case 'seminar_education':
      roleInstruction = `あなたは講義・研修・教育セミナーの記録担当です。
提示された画像から講義の進行と説明内容を時系列順に抽出してください。
- 講師の説明トピックや話題の切り替わり
- 提示されたスライド、資料、板書、図表、コードの主要テキストやタイトル
- 実演・デモンストレーション・操作手順の提示
- 受講者との質疑応答・ディスカッション
- 重要なポイントの強調・まとめ`;
      eventTypeExamples = `"topic_intro"(導入・題目), "lecture"(講義・解説), "demonstration"(実演・デモ), "slide_change"(資料・スライド提示), "qa"(質疑応答), "summary"(まとめ), "other"`;
      break;

    case 'situation':
    case 'meeting':
      roleInstruction = `あなたは映像記録・状況把握の専門担当です。
提示された画像から、映像内の情景・状況・風景・人物や物体の様子・発生した変化を時系列順に客観的に抽出してください。
- 撮影されている場所・環境・風景・天候や照明などの情景
- 映っている主要な対象物、乗り物、設備、人物の様子や動き
- 画面内で起きた出来事、変化、アクション、移動
- 状況の特徴や特記事項`;
      eventTypeExamples = `"scene"(風景・場面), "situation"(状況・状態), "action"(動き・行動), "change"(変化・推移), "event"(出来事), "other"`;
      break;

    case 'custom':
      roleInstruction = `あなたは映像解析・記録の専門担当です。
以下の【ユーザー指定の解析観点】に従って、提示された画像から事実を時系列順に抽出してください。

【ユーザー指定の解析観点】
${customPrompt?.trim() || '映像内の重要な変化や動作を時系列順に客観的事実として抽出してください。'}`;
      eventTypeExamples = `"event", "action", "change", "topic", "other" など適切な種別`;
      break;
  }

  return `${roleInstruction}

以下の動画区間から抽出された【${batchCount}枚のフレーム画像】（動画全体${duration.toFixed(1)}秒中の ${batchStartTime.toFixed(1)}秒〜${batchEndTime.toFixed(1)}秒付近、各フレームは約${interval.toFixed(1)}秒間隔、フレーム番号 #${batchStartIndex}〜#${batchEndIndex}）を時系列順に観察し、確認できる事実だけを日本語で詳細に抽出してください。

【重要指示】
1. 思考（Thinking/Reasoning）は必要最小限（3行以内）とし、速やかに指定のJSON形式で出力してください。
2. 添付された画像は全部で${batchCount}枚です。それぞれのフレーム番号は #${batchStartIndex} から #${batchEndIndex} です。
3. start_time と end_time は、動画全体の開始（0秒）からの絶対秒数（${batchStartTime.toFixed(1)}〜${batchEndTime.toFixed(1)}秒の範囲）で記載してください。
4. frame_index には提示されたフレーム番号（${batchStartIndex}〜${batchEndIndex}）を記載してください。
5. event_type には ${eventTypeExamples} を設定してください。
6. 必ず以下のJSON形式のオブジェクトのみを出力してください（Markdownコードブロックで囲んでください）。

\`\`\`json
{
  "events": [
    {
      "start_time": ${batchStartTime.toFixed(1)},
      "end_time": ${batchEndTime.toFixed(1)},
      "event_type": "situation",
      "description": "確認できる具体的な事実",
      "objects": ["対象物や情景の要素"],
      "confidence": 1.0,
      "frame_index": ${batchStartIndex}
    }
  ]
}
\`\`\``;
}

// 動画全体を直接入力する場合（Gemini等）のイベント抽出プロンプト生成
export function buildDirectVideoPrompt(params: BuildDirectVideoPromptParams): string {
  const { profileId, videoName, duration, customPrompt } = params;

  let roleInstruction = '';
  let eventTypeExamples = '';

  switch (profileId) {
    case 'operation':
      roleInstruction = `あなたは作業映像・機器操作映像の精密監査・記録担当です。
動画「${videoName}」（全体長: 約${duration.toFixed(1)}秒）の映像および音声を最初から最後まで詳細に解析し、行われたすべての作業動作、操作対象、点検・確認事項、状態変化を時系列順に漏れなく抽出してください。`;
      eventTypeExamples = `"operation"(操作), "inspection"(確認・点検), "setup"(準備・段取り), "cleanup"(片付け・復旧), "abnormal"(異常・注意), "other"`;
      break;

    case 'seminar_education':
      roleInstruction = `あなたは講義・研修・教育セミナーの記録担当です。
動画「${videoName}」（全体長: 約${duration.toFixed(1)}秒）の映像および音声を最初から最後まで詳細に解析し、講義の進行、トピックの切り替わり、スライドや資料の提示内容、実演デモ、質疑応答を時系列順に抽出してください。`;
      eventTypeExamples = `"topic_intro"(導入・題目), "lecture"(講義・解説), "demonstration"(実演・デモ), "slide_change"(資料・スライド提示), "qa"(質疑応答), "summary"(まとめ), "other"`;
      break;

    case 'situation':
    case 'meeting':
      roleInstruction = `あなたは映像記録・状況把握の精密解析担当です。
動画「${videoName}」（全体長: 約${duration.toFixed(1)}秒）の映像および音声を最初から最後まで詳細に解析し、映像全体の情景、周辺環境・風景、対象物や人物の様子・動き、発生した事象や状況の変化を時系列順に漏れなく抽出してください。`;
      eventTypeExamples = `"scene"(風景・場面), "situation"(状況・状態), "action"(動き・行動), "change"(変化・推移), "event"(出来事), "other"`;
      break;

    case 'custom':
      roleInstruction = `あなたは映像解析・記録の専門担当です。
動画「${videoName}」（全体長: 約${duration.toFixed(1)}秒）の映像および音声を最初から最後まで解析し、以下の【ユーザー指定の解析観点】に従って時系列イベントを抽出してください。

【ユーザー指定の解析観点】
${customPrompt?.trim() || '映像および音声から重要な変化や動作を時系列順に客観的事実として抽出してください。'}`;
      eventTypeExamples = `"event", "action", "change", "topic", "other" など適切な種別`;
      break;
  }

  return `${roleInstruction}

【出力形式指示】
1. 思考（Thinking）は最小限とし、速やかに以下のJSONフォーマットで出力してください。
2. start_time, end_time は動画開始（0秒）からの秒数（数値）で記載してください。
3. event_type には ${eventTypeExamples} を指定してください。
4. objects には関連する対象物、機器名、システム名、トピック名などの配列を記載してください。
5. 必ず以下のJSON形式のオブジェクトのみを出力してください。

\`\`\`json
{
  "events": [
    {
      "start_time": 0.0,
      "end_time": 15.0,
      "event_type": "situation",
      "description": "具体的な内容",
      "objects": ["対象物1", "情景要素2"],
      "confidence": 0.95,
      "frame_index": 1
    }
  ]
}
\`\`\``;
}

// 報告書生成用のプロンプト生成
export function buildReportPrompt(params: BuildReportPromptParams): string {
  const { profileId, videoName, duration, events, customPrompt } = params;
  const minutes = Math.floor(duration / 60);
  const seconds = Math.floor(duration % 60);
  const durationText = `${minutes}分${String(seconds).padStart(2, '0')}秒 (約${duration.toFixed(1)}秒)`;

  let roleInstruction = '';
  let structureTemplate = '';

  switch (profileId) {
    case 'operation':
      roleInstruction = 'あなたは作業報告書の作成担当です。以下の観測イベントだけを根拠に、正確で構造化された日本語の「作業報告書」をMarkdown形式で作成してください。推測は書かず、不確実な事実は明記してください。';
      structureTemplate = `# 作業報告書

## 作業概要
- **対象動画**: ${videoName}
- **総作業時間**: ${durationText}
- **作業目的・概要**: （観測イベントから要約）

## 時系列の作業手順・操作記録
（各作業ステップの開始時間〜終了時間、操作対象、具体的な動作を時系列で詳細に整理）

## 点検・確認結果および異常・留意事項
（目視点検、測定値、安全確認結果の有無、異常や留意事項の有無）

## 完了状態およびまとめ
（作業終了時の状態、復旧・片付け状況、完了確認）

## 根拠・トレーサビリティ
（観測イベント数、確認された映像フレーム・証跡に基づく根拠）`;
      break;

    case 'seminar_education':
      roleInstruction = 'あなたは研修・セミナー記録の作成担当です。以下の観測イベントだけを根拠に、受講者や関係者が振り返りやすい体系的な日本語の「セミナー・研修・教育 実施記録」をMarkdown形式で作成してください。';
      structureTemplate = `# セミナー・研修・教育 実施記録

## 研修・セミナー概要
- **対象動画**: ${videoName}
- **総所要時間**: ${durationText}
- **研修テーマ・概要**: （観測イベントから要約）

## カリキュラムおよびタイムライン
（時間ごとのトピック構成・進行タイムテーブル）

## 主要講義内容・要点まとめ
（各章・スライドにおける重要概念、解説内容、提示資料の要約）

## 実演・デモンストレーション内容
（実施されたデモ、操作実例、解説されたポイント）

## 質疑応答およびディスカッション
（取り上げられた質問、議論、回答内容）

## まとめ・受講者への推奨アクション
（重要ポイントの総括、次回までの実践課題など）

## 根拠
（映像タイムスタンプおよび観測イベントに基づく根拠）`;
      break;

    case 'situation':
    case 'meeting':
      roleInstruction = 'あなたは状況記録レポートの作成担当です。以下の観測イベントだけを根拠に、映像の内容・状況・風景・全体の概要がひと目で把握できる構造化された日本語の「状況記録レポート」をMarkdown形式で作成してください。推測は書かず、観測された事実を客観的に記述してください。';
      structureTemplate = `# 状況記録レポート

## 状況概要
- **対象動画**: ${videoName}
- **総所要時間**: ${durationText}
- **映像全体の概要**: （観測イベントから要約した全体の情景や状況）

## 撮影環境・風景・基本状況
- **主な撮影環境・場所・風景**: （屋外/屋内、天候、照明、周囲の環境など）
- **主要な被写体・対象**: （確認された主要な人物、物体、設備、車両など）

## 時系列の状況推移・出来事
（時間帯ごとの状況の変化、発生した動きや事象を時系列で詳細に整理）

## 特記事項および注目すべき状況変化
（明らかな状況の変化、特異な事象、留意点など）

## 根拠・観測データ
（観測イベント数、各タイムラインの映像フレームに基づく根拠）`;
      break;

    case 'custom':
      roleInstruction = `あなたはドキュメント作成の専門担当です。以下の観測イベントだけを根拠に、ユーザー指定の要件に従って日本語のMarkdownドキュメントを作成してください。

【ユーザー指定のドキュメント要件】
${customPrompt?.trim() || '観測イベントをもとに、概要、時系列詳細、まとめ、根拠を含む包括的な記録を作成してください。'}`;
      structureTemplate = `# ${videoName} 解析レポート

## 概要
- **対象動画**: ${videoName}
- **時間**: ${durationText}

## 詳細内容
（観測イベントに基づく詳細な記述）

## まとめ・所見

## 根拠
（観測イベントに基づく根拠）`;
      break;
  }

  return `${roleInstruction}

【構成・見出しの目安】
${structureTemplate}

【重要指示】
- 思考（Reasoning）は必要最小限とし、速やかにMarkdown本文を出力してください。
- 根拠となる観測イベントにない事実は勝手に創作しないでください。

動画名: ${videoName}
総時間: ${durationText}
観測イベント一覧 (${events.length}件):
${JSON.stringify(events, null, 2)}`;
}
