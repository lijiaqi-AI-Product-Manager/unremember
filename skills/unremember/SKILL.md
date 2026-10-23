---
name: unremember
description: Let a local Claude Code or dsh agent truly forget a confirmed secret, then resume the session.
---

# unremember

当用户说“把刚才那个暗号忘掉”“让 agent 忘记这段内容”时使用。

## 规则

1. **先确认目标**：让用户明确要忘的原文、消息 id 或描述；不要猜。
2. **不要在会话运行时改文件**：当前 agent 已经把上下文加载进内存，改了也不会生效。
3. 写一条待办请求。优先用 CLI：
   ```bash
   unremember pending <session-id> --text "<经用户确认的原文>"
   ```
   或者写 `~/.unremember/pending/<sessionId>.json`：
   ```json
   {
     "v": 1,
     "platform": "claude-code",
     "sessionId": "<session-id>",
     "createdAt": 1700000000000,
     "target": { "text": ["<经用户确认的原文>"] }
   }
   ```
   `platform` 只能是 `claude-code` 或 `dsh`。文件权限设为 0600。
4. 告诉用户：退出当前会话，然后运行
   ```bash
   unremember resume <session-id> --yes
   ```
5. skill 自己不改 transcript、不改 memory、不执行 apply。

## 为什么

`unremember` 会先出 dry-run 计划；`resume` 执行计划后才恢复会话。这样不会在 agent 仍持有旧上下文时做无效修改。
