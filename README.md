# Video Scripter

動画から、根拠付きの時系列イベント、概要ログ、報告書を生成するローカルWebアプリです。初期版では **LM Studio** を実際のAIプロバイダーとして利用します。

## 必要環境

- Node.js 22.13 以降
- [LM Studio](https://lmstudio.ai/)（任意のVision対応モデルをロードし、Developer > Start Server を実行）
- FFmpeg（動画からフレームを抽出するために必要）

FFmpegの導入例: macOS は `brew install ffmpeg`、Windows は `winget install Gyan.FFmpeg`、Ubuntu/Debian は `sudo apt install ffmpeg`。

## 導入～起動

ターミナルを起動し、Video Scripterのフォルダー／ディレクトリー上に移動します。

以下のコマンドを実行してください。

```bash
【導入】
npm install
npm run build

【起動】
npm run start
```

表示されたURL（通常 `http://localhost:5173`）をブラウザーで開きます。

LM StudioでAPIトークン認証を有効にしている場合は、アプリ右上の「設定」からトークンを入力して保存してください。「接続を確認」でロード済みモデルを確認できます。視覚入力に対応したモデルを選択してください。トークンはブラウザーに読み返さず、ローカルSQLiteにのみ保存します。

データ、アップロード動画、抽出フレーム、SQLiteデータベースはすべて `data/` に保存されます。動画の「削除」は、動画本体と関連する抽出フレーム、イベント、報告書、解析履歴を削除します。APIキーはこの初期版ではブラウザーに送信せず、LM StudioはローカルURLだけを使用します。


## 終了

npmを起動したコンソール上で Ctrl＋C キーを押してサーバーを停止します。

ブラウザーを閉じます。  
