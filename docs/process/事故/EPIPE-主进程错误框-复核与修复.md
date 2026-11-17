# EPIPE「主进程 JS 错误框」复核 / 修复 / 验证 证据包

修复位置：`src/main/index.ts:36-55`（import 之后、第一处 `console.log` 之前）

```ts
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
```

## 1. 成因（实测链条）

1. 父进程（启动脚本 / 管道读端）退出或 `child.stdout.destroy()` → 主进程 fd 1 变断管。
   实测：断管 0.6s 后主进程内 `fs.writeSync(1,'')` 抛 `EPIPE errno=-4047`。
2. 主进程下一次 `console.log` 写出去 → 失败。**注意机制**：不是 `console.log` 同步抛，
   而是 `process.stdout`（net.Socket）上的 **未处理 'error' 事件**（`Unhandled 'error' event`）。
   主进程侧实测（`.tmp/epipe/deep-before/main-side.log`）：

```
[write] t=1794277668867 [zoom] 页面加载完成，界面缩放 110%
[stdout error-event] t=1794277668868 code=EPIPE errno=-4047 syscall=write
Error: EPIPE: broken pipe, write
    at Socket._write (node:internal/net:75:18)
    at writeOrBuffer (node:internal/streams/writable:574:12)
    at _write (node:internal/streams/writable:503:10)
    at Writable.write (node:internal/streams/writable:512:10)
    at [kWriteToConsole] (node:internal/console/constructor:311:16)
    at console.log (node:internal/console/constructor:414:26)
```

3. Electron 主进程默认没有 `uncaughtException` 监听 → 未捕获 → 弹模态框 → 主线程被
   `showMessageBoxSync` 卡住（实测主进程 inspector 从此不再应答）。

隔离实验（纯 Node，`.tmp/epipe/epipe-probe2.mjs`）原始输出：

```
Error: EPIPE: broken pipe, write
    at Socket._write (node:internal/net:75:18)
    ...
Emitted 'error' event on Socket instance at:
    at emitErrorNT (node:internal/streams/destroy:170:8)
  errno: -4047, syscall: 'write', code: 'EPIPE'
```

## 2. 修复前证据

| 项 | 值 |
| --- | --- |
| 窗口类名 | `#32770` |
| 窗口标题 | `Error` |
| 所属进程 | 主进程 pid（与 electron 主进程一致，不是子进程） |
| 矩形 | 462,255-965,548 |
| 截图 | `.tmp/epipe/before/dialog.png`（裁切版 `.tmp/epipe/before/dialog-crop.png`） |
| 主进程状态 | 存活但卡死：inspector `1+1` 超时、`/json/list` TimeoutError、页面 CDP 求值超时 |
| 窗口枚举原始日志 | `.tmp/epipe/before/windows.log`、`.tmp/epipe/before/dialog.json` |
| 受控延时实验 | `.tmp/epipe/delay-before/delay.json`：断管 +1s 写日志仍 OK；+3s 再写 → 弹框 + 主进程卡死 |

## 3. 修复后证据（同一套脚本、同一套判据）

| 项 | 结果 |
| --- | --- |
| 断管后静置 8s | 无框，主进程存活 |
| 断管后 CDP reload | 无框，`/json/list` HTTP 200 |
| 断管后 IPC `app:zoom`（主进程日志） | 无框，HTTP 200 |
| 断管后界面 | 菜单点「每日录入」成功，页面文本正常，截图 `.tmp/epipe/after/after-reload.png` |
| 受控延时 +1/3/6/10/15/20s 各写一次日志 | 6 次全部捕获到 `EPIPE errno=-4047` 事件，**全程无框、主进程一直应答**（`.tmp/epipe/delay-after/observed-errors.log`） |
| 关窗退出 | `auto 快照 #9` 生成 + 轮转保留 7 份 + `before-quit：checkpoint + close` + exitCode 0 |
| 正常管道日志 | `.tmp/epipe/after-normal/app.log`（`[db] dataRoot:` / `[app] 窗口已创建` / `[zoom] 页面加载完成…` 全在） |

## 4. 门禁

- `npm run test` → 23 files / 495 passed | 3 skipped（exit 0）
- `npx tsc -p tsconfig.node.json --noEmit` → exit 0
- `npx tsc -p tsconfig.web.json --noEmit` → exit 0
- `npm run build` → exit 0
- 原始日志：`.tmp/epipe/gate.log`（修复前基线构建 `.tmp/epipe/build-before.log`）

## 5. 脚本清单（全部在 .tmp/epipe/）

- `epipe-probe2.mjs` 纯 Node 隔离实验（断管 → console.log → 未处理 error）
- `wins.ps1` 桌面顶层窗口枚举 / 截图 / WM_CLOSE 关窗
- `repro.mjs <label> break|normal` 复现台（断管 + reload + IPC + 界面 + 关窗快照）
- `delay.mjs <label> [cdp] [inspect] [--observe]` 受控延时实验（主进程 inspector 观测）
- `deep.mjs` 深诊断（主进程侧埋点：写日志 / EPIPE 事件 / 重抛）
- `single.mjs <label> reload|zoom` 单触发实验
- `inspect-test.mjs` 主进程 inspector 能力探测
