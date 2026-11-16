# File conflicts and replacement recovery / 同名冲突与覆盖恢复

## Expected target / 确认目标

Names are checked across all year/month directories, including names reserved by old links. Automatic rename candidates use the same rule. Replacement preserves the target directory and URL; existing links will show the new content.

同名检查覆盖全部年月目录及旧链接保留名称。自动改名遵守同一规则。覆盖保持目标文件原目录和 URL，已有笔记和页面将显示新内容。

`POST /api/image/upload-check` accepts `{ "items": [{ "filename": "cover.png" }] }`. A conflict result includes `conflict.year`, `month`, `filename`, and a SHA-256 computed from the current file bytes.

Uploading with `X-Conflict-Strategy: replace` (or `overwrite`) requires all four headers copied from the conflict the user confirmed:

- `X-Conflict-Target-Year`
- `X-Conflict-Target-Month`
- `X-Conflict-Target-Filename` (percent-encoded filename)
- `X-Conflict-Target-Sha256`

缺少目标字段、目标被移除或内容变化时返回 `409 CONFLICT_TARGET_CHANGED`。客户端必须重新展示最新冲突并让用户确认，不能自动覆盖另一个文件。**旧客户端仅发送 replace 策略的请求将被拒绝**；普通上传、哈希去重和自动改名无需这些字段。

For `POST /api/modules/image-host/trash/:id/restore`, rename uses `{ "conflictStrategy": "rename", "filename": "new.png" }`. Replacement uses:

```json
{
  "conflictStrategy": "replace",
  "filename": "cover.png",
  "conflictTarget": {
    "year": "2026",
    "month": "11",
    "filename": "cover.png",
    "sha256": "<64 lowercase hex characters from the confirmed conflict>"
  }
}
```

恢复覆盖仅允许作用于回收站条目原年月目录、原文件名对应的确认目标。输入新名称只检查名称是否可用，不改变比较对象；新名称已存在时需另选名称，不能借此覆盖另一个文件。请求改用其他文件名进行覆盖将返回 `409 CONFLICT_TARGET_CHANGED`。覆盖不会被其他位置已有相同内容的去重结果重定向。

Restore replacement is restricted to the trash entry’s original directory and filename. A rename availability check never changes the comparison or grants permission to overwrite a different file. Choose an unused name when renaming; a replacement request targeting another filename returns `409 CONFLICT_TARGET_CHANGED`.

## Commit and recovery / 提交与恢复

Uploads and trash restores share `replaceAsset`. It stages and verifies incoming bytes in the target directory, records an `asset_mutation` intent, copies the old bytes and metadata into the private recycle bin, then atomically renames the staged inode over the existing path. The original public path is never removed first.

原子改名是切换点。重启恢复根据目标字节区分：尚未切换时保留旧文件，清理未提交备份；已经切换时补齐新文件索引、缓存与回收站清理。发现非预期内容则停止自动恢复。恢复暂时失败时返回 `503 RECOVERY_PENDING` 并保留意图，后续变更先重试恢复。

These guarantees cover application exceptions and process restarts on a filesystem that provides atomic rename. They are not a claim of physical power-loss durability or protection against unrelated external writes. Replacement temporarily needs space for the staged incoming file and a backup of the old file.

回收站启动/每小时清理，以及管理 API 触发的清理，均进入文件变更队列。定时任务记录删除数量和失败原因。保留期为 0 时不自动删除；旧文件只能在自动清理前恢复。
