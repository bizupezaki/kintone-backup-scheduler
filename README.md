# kintone Backup Scheduler

Windows 環境で kintone の自動・手動バックアップ/復元を行う Electron アプリケーションです。

## 主な機能

-   **自動バックアップ**: Windows タスクスケジューラと連携した定期実行
-   **差分バックアップ**: 前回実行時からの変更レコードのみを高速バックアップ
-   **全体バックアップ**: 全レコードのバックアップ
-   **添付ファイル保存**: レコードに添付されたファイルもローカルに保存
-   **復元機能**: 過去のバックアップから選択して復元
-   **実行ログ**: kintone アプリにバックアップ履歴を自動記録

## 必要な環境

-   Windows 10/11
-   Node.js 18.x 以上
-   kintone アカウント（管理者権限推奨）

## インストール

```bash
# 依存関係のインストール
npm install

# 開発モードで起動
npm run dev

# ビルド（Windows用実行ファイル作成）
npm run build
```

## セットアップ

1. アプリケーションを起動
2. kintone のサブドメイン、ユーザー名、パスワードを入力
3. バックアップ記録用の kintone アプリ ID を入力
4. バックアップスケジュールを設定（曜日・時刻）
5. バックアップ対象のアプリを選択
6. 初回バックアップが自動実行されます

## kintone バックアップ記録アプリの設定

バックアップ履歴を記録するための kintone アプリを作成してください。
詳細なフィールド定義は `KINTONE_BACKUP_APP_FIELDS.md` を参照してください。

## データ保存形式

-   **メタデータ**: SQLite (`backup_data/metadata.db`)
-   **バックアップデータ**: JSON+ZIP 形式 (`backup_data/archives/`)
-   **添付ファイル**: `backup_data/attachments/[appId]/[recordId]/[backupDate]/`

## コマンドライン引数

```bash
# スケジュール実行（ヘッドレスモード）
KintoneBackupScheduler.exe --scheduled

# 開発モード
npm run dev
```

## ライセンス

MIT

## 技術スタック

-   Electron 27.x
-   @kintone/rest-api-client 5.x
-   better-sqlite3 9.x
-   archiver 6.x
-   axios + axios-retry
