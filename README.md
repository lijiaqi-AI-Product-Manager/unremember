# unremember

> 给本地 coding agent 一碗孟婆汤：定向删掉一段内容，连同它的复述和会话外副本，再用追问证明它真的忘了。

`unremember` 处理的是**本地会话**：Claude Code 和 dsh（DeepSeek Harness）。它不是“清空聊天”：它会先出计划，逐文件校验、备份、原子写入，然后在 fork 上追问，给出泄漏率。

## 状态

- MVP：Claude Code（≥ 2.1.30x）与 dsh（0.2.x，session v4）。
- 不做：Codex、国内平台、云端会话、正在运行的会话。Codex 0.164 只接受 Responses API，当前没有可用的测试 provider（见 `docs/调研/调研结果-03-补充实验.md`）。
- 所有实验和实现都不依赖官方私有 API；直接读写本地格式，格式不认识时拒绝执行。

## 安装

```bash
npm install
npm run build
node dist/cli.js --help
```

也可以 `npm link` 后直接使用 `unremember`。Node.js ≥ 22.19。

## 快速开始

```bash
# 列出本机会话（Claude Code 的 CLAUDE_CONFIG_DIR、dsh 的 DSH_HOME 会自动读取）
unremember sessions
unremember sessions --platform cc --cwd "C:\work\my-project"

# 先 dry-run：只出计划，不改文件
unremember plan last --text "青柠绿-7429"

# 确认计划后执行；会先备份
unremember apply 20261024-000620-ac72 --yes

# 在 fork 上追问，不污染原会话
unremember verify 20261011-... --canary "青柠绿-7429"

# 后悔了
unremember rollback 20261024-000620-ac72
unremember backups
unremember purge-backups --yes
```

`<会话>` 支持完整 id、id 前缀、transcript 路径，或 `last`。`plan` 默认按回合删除；只想切掉命中的句子时用 `--scope span`。

## 它会清什么

Claude Code：

- 主 transcript、子代理 transcript
- `history.jsonl`
- project memory（`MEMORY.md` 和主题文件；删主题文件时同步删索引行）
- `file-history` 快照、`paste-cache`、`tool-results`
- `api-request` / `api-request-blob`（整行删除，实验证明不参与恢复）
- `last-prompt` 的 `leafUuid`、`parentUuid` / `logicalParentUuid` 断链修复
- compact summary（`isCompactSummary`）里的命中按句改写
- 同一 `message.id` 下的 thinking/text/tool_use，以及 tool_use ↔ tool_result 的配对闭包

dsh：

- 当前 `session.v4.jsonl[.zstd]` 与历史 generation
- `agent/inbox/spliced`、`user/message`、`assistant/message` 的正文
- `assistant/message.data.stream`、`message.source.replayState`
- `session/title*`、`compaction/summary` 的 summary/rawOutput
- `storages` 里带 session id 的投影缓存、`attachments` 文本

dsh **绝不删行、绝不重排 seq**：只抹字段；`.zstd` 写回时 header 单独一帧、其余事件一帧，两个 frame 都带 checksum。

## 计划、备份与恢复

`plan` 只写 `~/.unremember/plans/<id>.json`，计划里只有：

- 目标文本的 sha256（不存原文）
- 命中的操作（文件、行、JSON pointer、span）
- 出计划时每个文件的 sha256
- blockers 和模拟执行后的 `residualHits`

`apply` 会：

1. 检查会话是否正在运行；检测失败按“正在运行”处理；
2. 复核每个文件的 sha256；
3. 备份到 `~/.unremember/backups/<id>/`；
4. 原子写入；
5. 写 `journal.jsonl`。

`rollback <id>` 按 manifest 还原并复核哈希。`purge-backups` 会永久删掉备份（删除后无法 rollback）。

## 验证

`verify` 只在 fork 上做：

- Claude Code：`claude -p ... --resume <id> --fork-session`；结束后删掉 fork 文件。
- dsh：复制 session 目录、换新 id、替换文件里所有旧 id（header 与 `delivery-accepted.data.sessionId` 等），运行后删掉。

20 个探针分 5 类（直接问、间接提示、列全部对话、原样输出上下文、查文件和 memory）。任意回答出现目标字面变体即记为泄漏；退出码 0 表示没有字面泄漏，1 表示有泄漏或探针执行失败。

## 隐私

- 默认离线，只做精确匹配；`--semantic` 目前没有配置裁判/定位模型时会明确提示。
- 计划、日志、journal 不保存目标原文。
- 备份保存原文，这是 rollback 必需的；确认无误后执行 `purge-backups`。
- skill 写入的 `~/.unremember/pending/<sessionId>.json` 含待确认字面文本，权限 0600；`resume` 消费后删除。

## 开发

```bash
npm test
npm run typecheck
npm run build
```

测试使用临时目录和合成 transcript，不读写真实 home。格式调研、实验和未确认项在 `docs/调研/`。

## 已知边界

- 正在运行的会话不会重新读文件，必须退出后执行；工具会拒绝 live/unknown 状态。
- 服务端、遥测、模型权重、已经提交到 git 的内容、其他机器不在承诺范围内。
- 目标若被模型改写成语义等价但字面不同，当前默认不命中；这属于 `--semantic` 的路线。
- 官方格式随时可能变；遇到未知条目类型时，`plan` 仍会扫描，但 `apply` 会拒绝。

## License

MIT
