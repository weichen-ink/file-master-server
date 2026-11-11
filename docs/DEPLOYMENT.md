# Docker 配置持久化

默认 Compose 文件已挂载 `storage/` 和 `data/`。站点配置 `config.yaml` 需要单独挂载，否则重建容器会丢失站点配置。

首次完成网页初始化后，在部署目录保存配置：

```sh
docker compose cp file-master-server:/app/config.yaml ./config.yaml
```

确认本地 `config.yaml` 文件已存在，然后取消 `docker-compose.yml` 中以下挂载行的注释：

```yaml
- ./config.yaml:/app/config.yaml
```

下次重建容器时会使用这份配置。配置内包含密码和访问令牌，请妥善保存，不要提交到公开仓库。升级前备份原文件、索引、配置和自定义水印；文件与索引的备份方式见[存储与恢复说明](SCALABILITY.md)。

## English

The default Compose file mounts `storage/` and `data/`. Mount `config.yaml` separately so site settings survive container recreation.

After completing first-time setup in the browser, save the configuration from your deployment directory:

```sh
docker compose cp file-master-server:/app/config.yaml ./config.yaml
```

Ensure the local `config.yaml` file exists, then uncomment this volume in `docker-compose.yml`:

```yaml
- ./config.yaml:/app/config.yaml
```

Future container recreations will use this file. It contains credentials: keep it private and out of public repositories. Before updates, back up original files, indexes, configuration, and custom watermarks. See [storage and recovery](SCALABILITY.md) for consistent file and index backups.
