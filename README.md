# Video Scripter

動画から、根拠付きの時系列イベント、概要ログ、報告書を生成するマルチAIプロバイダー対応Webアプリケーションです。

---

## 主な機能

### 1. マルチAIプロバイダー対応（Capability自動判定）
各AIベンダーの特性・入力Capabilityに合わせて自動で解析パイプラインを切り替えます。

| プロバイダー | 対象AI | 入力Capability | 備考 |
|---|---|---|---|
| **Google (Gemini)** | Gemini 2.5/2.0/1.5 Flash/Pro | `video_input = true`<br>`image_input = true` | Gemini File APIによる動画直接送信、またはフレーム画像解析に対応 |
| **LM Studio** | Qwen2.5-VL / Llama-3.2-Vision 等 | `video_input = false`<br>`image_input = true` | ローカルLLMによる完全ローカル解析 |
| **Anthropic** | Claude 3.7 / 3.5 Sonnet / Haiku | `video_input = false`<br>`image_input = true` | フレーム画像解析および高品質な報告書・議事録生成 |
| **OpenAI** | GPT-4o / GPT-4o-mini / o3-mini | `video_input = false`<br>`image_input = true` | 高精度なフレーム画像解析および構造化文書生成 |

### 2. 4つの解析プロファイル設定
解析用途に合わせてワンクリックで観点と報告書フォーマットを切り替えられます。

1. **🔧 作業・操作記録 (`operation`)**
   - 現場作業、点検、機器操作、PC/IT画面操作、組立・分解の手順・動作・操作対象・確認事項を詳細に記録。
2. **🎓 セミナー・研修・教育記録 (`seminar_education`)**
   - 講義、社内研修、技術セミナー、チュートリアルのアジェンダ進行、スライド提示内容、実演デモ、質疑応答を整理。
3. **🏞️ 状況記録 (`situation`)**
   - 映像の内容、状況、風景、環境、人物・物体の動きなどを記録し、全体の状況や概要を整理・構造化。
4. **✨ カスタム (`custom`)**
   - ユーザーが独自の解析観点プロンプトや報告書フォーマットを自由に指定可能。

### 3. Evidence Chain（検証可能性の確保）
AIが作成した文章だけでなく、動画ハッシュ、該当タイムスタンプ、抽出されたフレーム画像証跡を紐付けて保存します。

---

## 必要環境

- Node.js 22.13 以降
- FFmpeg（動画情報取得およびフレーム抽出に必要）
  - macOS: `brew install ffmpeg`
  - Windows: `winget install Gyan.FFmpeg`
  - Ubuntu/Debian: `sudo apt install ffmpeg`
- 使用したいプロバイダーの環境（いずれか1つ以上）：
  - LM Studio（ローカルでVisionモデルをロードしサーバー起動）
  - Google Gemini API Key
  - Anthropic API Key
  - OpenAI API Key

---

## 導入と起動

1. リポジトリのディレクトリに移動します。
2. 依存関係のインストールとビルド：
   ```bash
   npm install
   npm run build
   ```
3. アプリケーションの起動：
   ```bash
   npm run start
   ```
   （開発モードでホットリロードしたい場合は `npm run dev`）
4. ブラウザで `http://localhost:5173` を開きます。

---

## 設定方法

右上の「⚙ 設定・プロファイル」をクリックします。

- **AIプロバイダー設定**:
  - 利用したいプロバイダーのタブ（LM Studio / Gemini / OpenAI / Claude）を選択し、API URL、APIキー、モデル名を設定します。
  - 「🔄 接続を確認・モデル一覧を取得」ボタンで接続テストと利用可能モデルの自動取得が可能です。
- **解析プロファイル設定**:
  - デフォルトの解析プロファイルや、カスタムプロファイル用のプロンプトを設定・カスタマイズできます。

動画画面上でも、解析開始時や報告書生成時にプロファイルおよびAIプロバイダーを即座に切り替えて実行できます。

---

## データの保存場所

データ、アップロード動画、抽出フレーム、SQLiteデータベースはすべて `data/` にローカル保存されます。APIキーはブラウザに読み返さず、ローカルSQLiteに安全に保持されます。
