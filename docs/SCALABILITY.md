# 批处理与规模边界 / Batch processing and scale

当前版本面向个人知识库与单个服务进程。千张级图片使用文件存储和轻量索引，不需要额外数据库或分布式队列。同一份可写数据目录只运行一个服务实例；多实例共享写入不在当前支持范围内。

The supported deployment is one server process per writable storage directory. Thousands of images do not by themselves require a database or distributed queue. Multiple writers sharing a directory are not supported.

## 上传与迁移

- 上传先写入完整的临时文件，再以硬链接原子发布，且不覆盖已有文件。存储必须支持同目录硬链接；启动会在实际原文件目录中探测并向日志、管理后台报告，不支持时上传返回 501 并保留已有文件，不回退到可能暴露半成品的复制。名称冲突始终比较完整 SHA-256，短哈希后缀只用于命名。
- 服务端将上传落盘、删除和锁状态修改串行处理。图片转换独立使用最多 2 个活动任务、128 个等待任务的队列；相同缓存目标合并为同一任务。缓存清理会使旧任务失效。
- 上传限流保持每个 IP 每分钟 120 次。429 包含 `Retry-After`；插件和网页对 429、部分 5xx 和网络错误最多重试 4 次，不重试身份认证失败。
- 插件逐文件传输，随后按受影响笔记集中修改最新正文。删除前重新读取引用，并核对本地附件内容；最终检查后笔记发生变化时保留本地文件。
- 插件取消会停止后续传输及重试等待。Obsidian 的 `requestUrl` 在途请求无法由本插件直接中止，当前请求可能先完成；已经上传成功的文件仍会完成链接更新。
- 插件保存最近一次上传的恢复清单 `migration-pending.json`。失败、取消或重启后，在命令面板运行“恢复未完成上传”，检查所列文件后继续。服务器地址必须与原任务一致；再次上传由服务端 SHA 去重。开始另一项上传会替换此恢复清单。
- 网页可停止上传并重试未完成项；浏览器刷新后需要重新选择文件。下载批次可在结果页重试，下载内容在写入前与原文件 SHA 比较。

Storage must support same-directory hard links; startup probes the actual original-file directory and reports failures in logs and the admin console. Unsupported storage returns 501 without exposing partial copies. Uploads publish complete files exclusively and deduplicate only by full SHA-256. Image generation has bounded concurrency and coalesces identical requests. Transfers retry transient failures, preserve current note edits, and verify originals before local deletion. Plugin upload recovery covers the most recent upload; browser retry state lasts until page reload. Cancellation finishes already successful transfers consistently.

## 引用、列表与图库

插件在一次操作内建立引用反向索引，用多目标匹配一次处理每篇笔记，避免每张图片重新扫描全部笔记。同名文件采用保守引用判断，可能保留额外副本，避免误删。

服务端异步扫描目录、流式补算哈希，每月只统计一次同名情况和缓存文件元数据。列表结果缓存 30 秒，上传、删除、锁修改和缓存变更会使其失效。列表 API 仍返回完整元数据，以兼容现有客户端；当前规模无需强制服务端分页。

网页、插件弹窗和侧栏图库每页最多渲染 60 项。支持转换的图片使用最长宽 320、高 240 的 WebP 缩略图，预览与插入链接仍指向用户选择的原图或公开图。列表扫描不预先转码全部图片。

References are indexed per operation. Catalog scans are asynchronous, while galleries paginate 60 entries and request bounded thumbnails. The list API remains compatible and returns the full metadata catalog.

## 快速检查与完整校验

失效链接检查只判断引用目标或 URL 是否存在、可达，不证明内容正确。原文件完整校验可在服务器文件页面点击“校验原文件”，停止任务或下载 JSON 报告，也可通过以下接口操作：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/modules/image-host/integrity` | 开始校验；已有任务运行时返回该任务 |
| GET | `/api/modules/image-host/integrity` | 查询进度与结果 |
| DELETE | `/api/modules/image-host/integrity` | 停止当前任务 |

接口均要求 API Token 或管理员会话。每个进程最多一个校验任务，重启后任务状态不保留，可重新执行。报告区分内容不符、缺失、尚未索引、检查期间变化及不可读文件。校验读取原文件字节，不使用快速哈希缓存，不检查 WebP 等衍生图，也不自动修复文件或接受新的基准。

`data/sha_index.json` 使用版本 2 的按路径记录，读取时兼容旧索引。每个路径保留首次已知 SHA 基准，因此普通列表扫描发现文件变化后，不会抹掉完整校验所需的旧基准。原文件通过接口上传后不会原位覆盖；手工替换已有原文件会被报告为变化。

首次建立索引不能证明文件过去未损坏。请备份 `storage/raw/`、`data/sha_index.json`、`config.yaml` 和自定义水印；恢复原文件时一并恢复对应索引。删除索引会丢失已有完整性基准，不能将删除索引作为处理校验错误的方法。回退旧版服务端前，应保留这份索引备份；旧版不支持版本 2 的完整性基准。

Full verification streams original bytes against persistent per-path baselines. Normal scans do not replace those baselines. Reports are read-only; they do not silently accept corrupted content. Back up originals and their index together. An initial baseline cannot establish historical integrity, and verification is not a backup.

## 验证与后续升级条件

运行 `npm test`。测试运行器为每个测试文件建立独立临时项目，并行执行后自动清理，不会读写实际配置、图片或索引。`tests/server_scale.test.js` 自动建立独立临时项目，生成 1,000 张小图片，验证冷/热列表、事件循环让出、运行指标、重复副本删除、内容篡改与索引重启兼容性。测试不会使用实际用户配置或图片。

插件仓库运行 `npm run build`、`npm test`、`node scripts/benchmark-references.js`。引用基准包含 1,000 和 3,000 张附件及同等数量的约 9.6KB 合成笔记。

这些测试验证元数据与算法路径，不是实际大图上传、HEIC 转换、慢网或手机实机容量承诺。部署前仍应按实际图片大小、格式、服务器内存和网络带宽测试代表性批次。

只有出现多进程写入、复杂查询或持久任务需求时，再评估 SQLite 或独立任务执行器。运行数据迁移到可配置的独立目录属于后续部署改进，本轮保持现有路径以兼容更新和备份流程。

The scale fixtures validate metadata and algorithm behavior, not real-world throughput for large photos or mobile devices. Add a database or separate workers when concurrent writers or persistent job requirements justify them, rather than based on image count alone.

## 更新器边界 / Updater boundaries

`updater.js` 负责步骤顺序、互斥锁与失败处理；`update-backup.js` 负责备份格式和恢复；`update-git.js` 负责 Git、状态查询和命令执行。公开更新接口、磁盘备份布局和旧清单兼容性保持不变。测试为更新器提供独立目录及命令边界，覆盖成功、fetch/reset/恢复/依赖安装失败、并发请求与重置后进程退出；另有本地 Git 仓库集成测试，不访问 GitHub。

失败处理保障配置和水印的恢复，不承诺把已经更新的源代码与依赖一并回退。依赖安装失败会保留待完成标记与备份，并在更新状态中提示。排除错误后，即使目标提交相同，再次更新仍会执行依赖安装，全部成功才清除标记。启动恢复不运行 npm，且已恢复的用户文件不会反复被备份覆盖；原文件完整性校验独立于更新恢复。

The coordinator owns update ordering and its lock; backup/recovery and Git execution live in focused modules. Tests exercise offline Git and process interruption. Recovery protects user configuration and watermarks; it does not promise a transactional rollback of source code and installed dependencies. Failed or interrupted installation remains pending across restarts and forces installation on the next hot update, including the same commit. Startup recovery does not execute npm or overwrite already-restored user assets.
