const Database = require('better-sqlite3');
const path = require('path');

class DatabaseManager {
    constructor(dbPath) {
        this.db = new Database(dbPath);
        this.initializeTables();
    }

    initializeTables() {
        // バックアップ履歴テーブル
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        app_name TEXT,
        backup_type TEXT NOT NULL,
        trigger_type TEXT,
        start_time TEXT NOT NULL,
        end_time TEXT,
        duration_seconds REAL,
        record_count INTEGER,
        file_path TEXT,
        data_size_mb REAL,
        compression_ratio REAL,
        status TEXT NOT NULL,
        error_details TEXT,
        api_request_count INTEGER DEFAULT 0,
        retry_count INTEGER DEFAULT 0,
        diff_base_datetime TEXT,
        hostname TEXT,
        app_version TEXT,
        remarks TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

        // アプリ設定テーブル
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT UNIQUE NOT NULL,
        app_name TEXT,
        is_active BOOLEAN DEFAULT 1,
        last_backup_datetime TEXT,
        last_full_backup_datetime TEXT,
        field_info TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

        // レコードインデックステーブル（差分バックアップ用）
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS record_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        updated_time TEXT NOT NULL,
        last_backup_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(app_id, record_id)
      );
    `);

        // インデックス作成
        this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_backups_app_id ON backups(app_id);
      CREATE INDEX IF NOT EXISTS idx_backups_start_time ON backups(start_time);
      CREATE INDEX IF NOT EXISTS idx_backups_status ON backups(status);
      CREATE INDEX IF NOT EXISTS idx_record_index_app_id ON record_index(app_id);
      CREATE INDEX IF NOT EXISTS idx_record_index_updated_time ON record_index(updated_time);
    `);
    }

    // バックアップ履歴の追加
    insertBackup(backupData) {
        const stmt = this.db.prepare(`
      INSERT INTO backups (
        app_id, app_name, backup_type, trigger_type, start_time, 
        end_time, duration_seconds, record_count, file_path, 
        data_size_mb, compression_ratio, status, error_details, 
        api_request_count, retry_count, diff_base_datetime,
        hostname, app_version, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        const result = stmt.run(
            backupData.app_id,
            backupData.app_name,
            backupData.backup_type,
            backupData.trigger_type,
            backupData.start_time,
            backupData.end_time,
            backupData.duration_seconds,
            backupData.record_count,
            backupData.file_path,
            backupData.data_size_mb,
            backupData.compression_ratio,
            backupData.status,
            backupData.error_details,
            backupData.api_request_count || 0,
            backupData.retry_count || 0,
            backupData.diff_base_datetime,
            backupData.hostname,
            backupData.app_version,
            backupData.remarks
        );

        return result.lastInsertRowid;
    }

    // バックアップ履歴の更新
    updateBackup(backupId, updateData) {
        const fields = Object.keys(updateData)
            .map((key) => `${key} = ?`)
            .join(', ');
        const values = Object.values(updateData);
        values.push(backupId);

        const stmt = this.db.prepare(`UPDATE backups SET ${fields} WHERE id = ?`);
        return stmt.run(...values);
    }

    // バックアップ履歴の取得
    getBackupHistory(filters = {}) {
        let query = 'SELECT * FROM backups WHERE 1=1';
        const params = [];

        if (filters.app_id) {
            query += ' AND app_id = ?';
            params.push(filters.app_id);
        }

        if (filters.backup_type) {
            query += ' AND backup_type = ?';
            params.push(filters.backup_type);
        }

        if (filters.status) {
            query += ' AND status = ?';
            params.push(filters.status);
        }

        if (filters.start_date) {
            query += ' AND start_time >= ?';
            params.push(filters.start_date);
        }

        if (filters.end_date) {
            query += ' AND start_time <= ?';
            params.push(filters.end_date);
        }

        query += ' ORDER BY start_time DESC';

        if (filters.limit) {
            query += ' LIMIT ?';
            params.push(filters.limit);
        }

        const stmt = this.db.prepare(query);
        return stmt.all(...params);
    }

    // 特定のバックアップ詳細取得
    getBackupById(backupId) {
        const stmt = this.db.prepare('SELECT * FROM backups WHERE id = ?');
        return stmt.get(backupId);
    }

    // バックアップの削除
    deleteBackup(backupId) {
        // record_index から削除（カラム名は last_backup_id）
        const deleteIndexStmt = this.db.prepare('DELETE FROM record_index WHERE last_backup_id = ?');
        deleteIndexStmt.run(backupId);

        // backups から削除
        const deleteBackupStmt = this.db.prepare('DELETE FROM backups WHERE id = ?');
        deleteBackupStmt.run(backupId);
    }

    // アプリの保存/更新
    upsertApp(appData) {
        const stmt = this.db.prepare(`
      INSERT INTO apps (app_id, app_name, is_active, field_info, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(app_id) DO UPDATE SET
        app_name = excluded.app_name,
        is_active = excluded.is_active,
        field_info = excluded.field_info,
        updated_at = CURRENT_TIMESTAMP
    `);

        return stmt.run(appData.app_id, appData.app_name, appData.is_active !== undefined ? appData.is_active : 1, appData.field_info ? JSON.stringify(appData.field_info) : null);
    }

    // アプリ一覧の取得
    getAllApps(activeOnly = false) {
        let query = 'SELECT * FROM apps';
        if (activeOnly) {
            query += ' WHERE is_active = 1';
        }
        query += ' ORDER BY app_name';

        const stmt = this.db.prepare(query);
        const apps = stmt.all();

        return apps.map((app) => ({
            ...app,
            field_info: app.field_info ? JSON.parse(app.field_info) : null,
        }));
    }

    // アプリの最終バックアップ時刻を更新
    updateAppLastBackup(appId, backupDatetime, isFullBackup = false) {
        const fields = ['last_backup_datetime = ?', 'updated_at = CURRENT_TIMESTAMP'];
        const params = [backupDatetime];

        if (isFullBackup) {
            fields.push('last_full_backup_datetime = ?');
            params.push(backupDatetime);
        }

        params.push(appId);

        const stmt = this.db.prepare(`
      UPDATE apps SET ${fields.join(', ')} WHERE app_id = ?
    `);

        return stmt.run(...params);
    }

    // レコードインデックスの更新（差分バックアップ用）
    upsertRecordIndex(appId, recordId, updatedTime, backupId) {
        const stmt = this.db.prepare(`
      INSERT INTO record_index (app_id, record_id, updated_time, last_backup_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(app_id, record_id) DO UPDATE SET
        updated_time = excluded.updated_time,
        last_backup_id = excluded.last_backup_id
    `);

        return stmt.run(appId, recordId, updatedTime, backupId);
    }

    // 最終バックアップ以降に更新されたレコードを取得
    getRecordsToBackup(appId, sinceDateTime) {
        const stmt = this.db.prepare(`
      SELECT record_id, updated_time
      FROM record_index
      WHERE app_id = ? AND updated_time > ?
      ORDER BY updated_time
    `);

        return stmt.all(appId, sinceDateTime);
    }

    // アプリの最終バックアップ日時を取得
    getLastBackupDatetime(appId) {
        const stmt = this.db.prepare(`
      SELECT last_backup_datetime, last_full_backup_datetime
      FROM apps
      WHERE app_id = ?
    `);

        return stmt.get(appId);
    }

    // トランザクション実行
    transaction(callback) {
        const trx = this.db.transaction(callback);
        return trx();
    }

    // データベースクローズ
    close() {
        this.db.close();
    }
}

module.exports = DatabaseManager;
