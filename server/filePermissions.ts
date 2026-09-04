// ローカルファイルのパーミッションを締める(chmod)ためのユーティリティ。
// APIキー等の秘密情報を含むSQLiteデータベースや、アップロードされた動画・
// 抽出フレーム画像を、同一マシンの他OSユーザーから読み取れないようにする多層防御。
//
// 注意: これはあくまで多層防御であり、単独では秘密情報を保護しきれない。
// - NTFS等、POSIXパーミッションを厳密に持たないファイルシステムでは効果が限定的、
//   または無効になる場合がある。
// - クラウド同期フォルダ(Dropbox/Google Drive/Synology Drive等)配下で運用する場合、
//   同期先で権限がリセットされたり、同期先の他ユーザーから読める可能性が残る。
import { chmodSync, existsSync } from 'node:fs';

// ディレクトリ: 所有者のみ読み書き・移動可能(700)
export const DIR_MODE = 0o700;
// ファイル: 所有者のみ読み書き可能(600)
export const FILE_MODE = 0o600;

export function hardenPermissions(paths: string[], mode: number): void {
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      chmodSync(p, mode);
    } catch {
      // chmodが失敗/無意味な環境(NTFS等)では黙って無視する。必須ではなく多層防御の一つ。
    }
  }
}
