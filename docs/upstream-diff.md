# 上游差异记录（upstream diff）

本文件记录本 fork 相对上游 `ZSeven-W/dsh-crew` 的所有差异。T01 只做 fork 与基线冻结，**未修改任何源码**，因此差异清单初始为空；后续任务（T03 起）每完成一项在此登记。

## 基线

| 项目 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/ZSeven-W/dsh-crew |
| 本机 fork | https://github.com/Augenblick0v0/dsh-crew |
| 基线 commit | `b0ddd92eeccbd7623c5a5924f0eb61005a2038ec` |
| 基线 commit 说明 | Merge pull request #18 from ZSeven-W/fix/worker-probe-and-question-handoff（2026-10-08 17:53:45 +0800） |
| 包版本 | `@zseven-w/dsh-crew@0.1.0-rc.14` |
| 工作分支 | `feat/multiturn`（基于上述 commit） |
| 冻结日期 | 2026-10-31（Asia/Shanghai） |

`git remote -v`：

```
origin	https://github.com/Augenblick0v0/dsh-crew (fetch)
origin	https://github.com/Augenblick0v0/dsh-crew (push)
upstream	https://github.com/ZSeven-W/dsh-crew (fetch)
upstream	https://github.com/ZSeven-W/dsh-crew (push)
```

## 基线测试（V01）

- 命令：`cd /root/dsh-crew && node --test tests/*.test.mjs`
- 依赖安装：`pnpm install`（pnpm 11.21.0，exit 0）
- 结果：`# tests 46` / `# pass 46` / `# fail 0` / `# cancelled 0` / `# skipped 0`，exit 0
- 完整输出：`docs/baseline-test.log`

## 差异清单

（初始为空：本任务未改动源码，工作区仅新增 `docs/baseline-test.log` 与本文件。）

后续改动按以下格式登记：

| commit | 文件 | 变更摘要 | 对应任务 |
| --- | --- | --- | --- |
