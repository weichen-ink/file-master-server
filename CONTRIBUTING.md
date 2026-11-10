# Contributing / 开发约定

## Server validation / 服务端验证

Run `npm ci` then `npm test` from this repository. Keep development dependencies installed when running tests. The runner creates a separate temporary project for each test file and cleans it up. Direct `node --test` skips this protection; the configuration test refuses to touch a non-isolated checkout. Do not disable that guard or point tests at a live config, storage, or index.

在本仓库使用 `npm ci` 安装含开发依赖的环境，再运行 `npm test`。每个测试文件都在独立临时项目中执行并自动清理。直接 `node --test` 会绕过隔离，配置测试会拒绝执行。不要移除保护断言，也不要让测试指向真实配置、原文件或索引。

Use focused modules and explicit dependencies. Preserve atomic upload publication, full-hash deduplication, and existing integrity baselines. Keep update failure state until every required step succeeds; recovery must not overwrite user edits after restoration. Update both English and Chinese documentation and console translations when behavior changes.

按职责组织模块并显式声明依赖。保持上传原子发布、完整哈希去重和已有完整性基准。更新所需步骤全部完成后才能清理状态；恢复不能反复覆盖已恢复后的用户修改。行为变更需同步更新中英文文档和后台翻译。

## Release validation / 发布验证

- Run server `npm test`; in the plugin repository run `npm test` (automatically rebuilds `main.js`) and `npm run package`. Commit the plugin source and generated bundle together.
- Use a test vault and representative images in real desktop and mobile Obsidian: clipboard upload, batch migration, cancel/retry, and Excalidraw roundtrip links. Check local bytes and references before/after deletion.
- Check server startup storage warnings and update failure/retry behavior on the intended deployment volume. Back up originals, their index, config, and custom watermarks consistently.
- Record which host versions/devices were actually tested before tagging. Automated host adapters and synthetic scale fixtures do not establish real-device throughput or UI compatibility.

发布前运行服务端 `npm test`，插件运行 `npm test`（会自动重建 `main.js`）及 `npm run package`，源码和 bundle 一并提交。使用测试库与代表性图片，在真实桌面和移动端 Obsidian 验证剪贴板上传、批量迁移、停止后重试及 Excalidraw 往返链接，核对清理前后的文件字节和引用。检查实际部署卷上的存储提示及更新失败重试，做好原文件、索引、配置与水印的一致性备份。记录实际测试的宿主版本和设备，再打 tag；自动化适配器和合成规模测试不能代替实机验证。
