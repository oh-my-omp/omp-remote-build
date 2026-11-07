# G2 同负载前后对比 — oh-my-omp/omp-remote-build#21

负载：临时 git 仓库（opt-in 配置）内 main checkout、linked worktree、nested repo（自带 opt-in）与非 git plain dir 各一；对每个 cwd 构造真实 ExtensionContext（含 sessionManager stub），经真实插件 default export 注册的 `before_agent_start` 钩子做 24 回合激活集重判；`Bun.spawn` 以计数 wrapper 观测子进程。脚本 `test/hook-paths.ts`（验收表 1-4 全部场景在同一脚本内），EXPECT_LIGHT=0 为基线模式。

| 指标 | 基线（3b85f9d） | 改后 | 方向 |
|---|---|---|---|
| 每回合路径子进程（24 回合 × 4 cwd） | 96（git，每回合每 cwd 1 个） | **0** | ↓ 96→0 |
| 激活集（main/worktree/nested/plain） | read,edit,container_exec,container_kill_session,container_list_sessions,container_write_stdin,remote_env_init（plain 无插件工具） | 与基线逐项相同 | G3 不变 |
| 边界判定（非 git plain、broken gitfile、symlink cwd） | 无工具 / 无工具 / 完整工具 | 与基线相同 | G3 不变 |
| isolated 判定（单 is、单非 is、无 init、兄弟分支晚到 is、非子代理） | true/false/false/true/false | 与基线相同 | G3 不变 |
| /worktree 主机检查触发（项目内 ssh，项目外无 ssh） | 是/否 | 是/否 | G3 不变 |

isolated 判定说明：每子代理 session_start 恰好一次 `getEntries()`（全量浅拷贝）不变——宿主 `ReadonlySessionManager` 只暴露会拷贝或更大分配的全量入口（详见 PR 内说明），issue 决策行 3 允许并要求此情形如实记录。
