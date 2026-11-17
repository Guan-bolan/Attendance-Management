# ATT_DATA_ROOT 端到端验证证据（2026-11-06 11:42–11:52）

## 关键结论
- 源码态：ATT_DATA_ROOT 生效。
- 打包态（dist 现有产物）：ATT_DATA_ROOT 不生效——dist 的 app.asar 是 11:24:39 打的旧代码，不含该特性。
- 打包态（用当前 out/ 重打 app.asar）：ATT_DATA_ROOT 生效，建工人、快照、落盘全部通过。

## 原始日志摘录

### dev（npm run dev）
```
[db] dataRoot: E:\Attendance Management\.tmp\att-final\dev（来源：环境变量 ATT_DATA_ROOT，原始值：.tmp\att-final\dev）
[db] 打开库文件: E:\Attendance Management\.tmp\att-final\dev\app.db
[db] 连接成功；PRAGMA journal_mode=wal
[db] PRAGMA foreign_keys=1 busy_timeout=5000 synchronous=1 wal_autocheckpoint=1000
[db] 迁移完成：v0 → v5（迁移前版本 v0）
[db] 表（13）：advances, archives, entries, entry_photos, photos, schema_version, settings, settlements, sites, snapshots, worker_overrides, worker_rates, workers
[app] CSP 已挂载：default-src 'self'; img-src 'self' att-photo: data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' att-photo: ws: wss: http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'self'; form-action 'none'
[app] 窗口已创建：鑫淼考勤
[snapshot] 已生成 auto 快照 #1：E:\Attendance Management\.tmp\att-final\dev\snapshots\20261106-114402-081-auto.db（139264 字节）
[snapshot] 退出快照 #1：E:\Attendance Management\.tmp\att-final\dev\snapshots\20261106-114402-081-auto.db；轮转保留 7 份，删除 0 份
[db] before-quit：checkpoint + close
[db] 连接已关闭
```
### dist\win-unpacked（旧包，实际打到真实目录）
```
[db] dataRoot: C:\Users\<USER>\Documents\Attendance
[db] 打开库文件: C:\Users\<USER>\Documents\Attendance\app.db
[db] 连接成功；PRAGMA journal_mode=wal
[db] PRAGMA foreign_keys=1 busy_timeout=5000 synchronous=1 wal_autocheckpoint=1000
[db] 迁移完成：v4 → v5（迁移前版本 v4）
[db] 表（13）：advances, archives, entries, entry_photos, photos, schema_version, settings, settlements, sites, snapshots, worker_overrides, worker_rates, workers
[app] CSP 已挂载：default-src 'self'; img-src 'self' att-photo: data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' att-photo: ws: wss: http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'self'; form-action 'none'
[app] 窗口已创建：鑫淼考勤
```
### 重打包（当前生产构建）
```
[db] dataRoot: E:\Attendance Management\.tmp\att-final\packed-prod（来源：环境变量 ATT_DATA_ROOT，原始值：.tmp\att-final\packed-prod）
[db] 打开库文件: E:\Attendance Management\.tmp\att-final\packed-prod\app.db
[db] 连接成功；PRAGMA journal_mode=wal
[db] PRAGMA foreign_keys=1 busy_timeout=5000 synchronous=1 wal_autocheckpoint=1000
[db] 迁移完成：v0 → v5（迁移前版本 v0）
[db] 表（13）：advances, archives, entries, entry_photos, photos, schema_version, settings, settlements, sites, snapshots, worker_overrides, worker_rates, workers
[app] CSP 已挂载：default-src 'self'; img-src 'self' att-photo: data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' att-photo: ws: wss: http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'self'; form-action 'none'
[app] 窗口已创建：鑫淼考勤
[snapshot] 已生成 auto 快照 #1：E:\Attendance Management\.tmp\att-final\packed-prod\snapshots\20261106-115056-134-auto.db（139264 字节）
[snapshot] 退出快照 #1：E:\Attendance Management\.tmp\att-final\packed-prod\snapshots\20261106-115056-134-auto.db；轮转保留 7 份，删除 0 份
[db] before-quit：checkpoint + close
[db] 连接已关闭
```
