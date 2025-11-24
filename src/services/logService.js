const winston = require('winston');
const path = require('path');
const fs = require('fs-extra');

class LogService {
    constructor(logDir) {
        this.logDir = logDir;
        this.initializeLogger();
    }

    initializeLogger() {
        // ログディレクトリの作成
        fs.ensureDirSync(this.logDir);

        // ログフォーマット
        const logFormat = winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.errors({ stack: true }),
            winston.format.printf(({ timestamp, level, message, stack }) => {
                return stack ? `${timestamp} [${level.toUpperCase()}]: ${message}\n${stack}` : `${timestamp} [${level.toUpperCase()}]: ${message}`;
            })
        );

        // ロガーの作成
        this.logger = winston.createLogger({
            level: 'info',
            format: logFormat,
            transports: [
                // エラーログファイル
                new winston.transports.File({
                    filename: path.join(this.logDir, 'error.log'),
                    level: 'error',
                    maxsize: 5242880, // 5MB
                    maxFiles: 5,
                }),
                // 結合ログファイル
                new winston.transports.File({
                    filename: path.join(this.logDir, 'combined.log'),
                    maxsize: 5242880, // 5MB
                    maxFiles: 5,
                }),
                // コンソール出力
                new winston.transports.Console({
                    format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
                }),
            ],
        });
    }

    info(message, meta = {}) {
        this.logger.info(message, meta);
    }

    error(message, error = null, meta = {}) {
        if (error) {
            this.logger.error(message, { ...meta, error: error.message, stack: error.stack });
        } else {
            this.logger.error(message, meta);
        }
    }

    warn(message, meta = {}) {
        this.logger.warn(message, meta);
    }

    debug(message, meta = {}) {
        this.logger.debug(message, meta);
    }

    // バックアップ開始ログ
    logBackupStart(appId, appName, backupType, triggerType) {
        this.info(`Backup started: [${backupType}] ${appName} (${appId})`, {
            appId,
            appName,
            backupType,
            triggerType,
        });
    }

    // バックアップ成功ログ
    logBackupSuccess(appId, appName, recordCount, duration) {
        this.info(`Backup completed: ${appName} (${appId}) - ${recordCount} records in ${duration}s`, {
            appId,
            appName,
            recordCount,
            duration,
        });
    }

    // バックアップ失敗ログ
    logBackupFailure(appId, appName, error) {
        this.error(`Backup failed: ${appName} (${appId})`, error, {
            appId,
            appName,
        });
    }

    // 復元開始ログ
    logRestoreStart(appId, appName, recordCount) {
        this.info(`Restore started: ${appName} (${appId}) - ${recordCount} records`, {
            appId,
            appName,
            recordCount,
        });
    }

    // 復元成功ログ
    logRestoreSuccess(appId, appName, recordCount, duration) {
        this.info(`Restore completed: ${appName} (${appId}) - ${recordCount} records in ${duration}s`, {
            appId,
            appName,
            recordCount,
            duration,
        });
    }

    // 復元失敗ログ
    logRestoreFailure(appId, appName, error) {
        this.error(`Restore failed: ${appName} (${appId})`, error, {
            appId,
            appName,
        });
    }
}

module.exports = LogService;
