# Docker 配置持久化

默认 `docker-compose.yml` 已通过目录挂载 `storage/`、`data/` 和 `config/`（并设置 `FILE_MASTER_CONFIG_DIR=/app/config`），站点配置将直接持久化在宿主机的 `./config/config.yaml`，支持在网页端原子保存配置而不会触发单文件挂载的 `EBUSY` 错误。

如果是从早期未挂载 `./config` 的旧容器升级，请**在重建旧容器之前**先将旧容器内的配置文件导出到宿主机 `./config/` 目录：

```sh
mkdir -p ./config
docker compose cp file-master-server:/app/config.yaml ./config/config.yaml
```

若宿主机项目根目录已有旧的 `./config.yaml` 且 `./config/config.yaml` 尚未存在，请在启动新版 Docker Compose **之前**手动复制到 `./config/` 目录（因为默认 Compose 仅挂载 `./config` 目录，容器内无法自动读取未挂载的宿主机 `./config.yaml`）：

```sh
mkdir -p ./config
cp ./config.yaml ./config/config.yaml
```

（若直接以 Node.js 运行且服务进程可直接访问原路径的 `config.yaml`，首次启动时会自动复制迁移到 `FILE_MASTER_CONFIG_DIR/config.yaml`。）从备份归档恢复时，请将归档内的 `config.yaml` 放回 `./config/config.yaml`。

配置内包含密码和访问令牌，请妥善保存，不要提交到公开仓库。升级前备份原文件、索引、配置和自定义水印；文件与索引的备份方式见[存储与恢复说明](SCALABILITY.md)。

## English

The default `docker-compose.yml` mounts `storage/`, `data/`, and `config/` as directories (with `FILE_MASTER_CONFIG_DIR=/app/config`), persisting site settings at `./config/config.yaml` on the host and allowing atomic config saves from the web admin without single-file bind-mount `EBUSY` errors.

If you are upgrading from an older container that did not mount `./config`, export the existing configuration **before** recreating the old container:

```sh
mkdir -p ./config
docker compose cp file-master-server:/app/config.yaml ./config/config.yaml
```

If a legacy `./config.yaml` already exists at the host project root while `./config/config.yaml` does not, copy it into `./config/` **before** starting the updated Docker Compose stack (the default Compose mounts only `./config`, so the container cannot read an unmounted host `./config.yaml`):

```sh
mkdir -p ./config
cp ./config.yaml ./config/config.yaml
```

(When running directly with Node.js where the legacy `config.yaml` is visible to the server process, startup automatically copies it to `FILE_MASTER_CONFIG_DIR/config.yaml`.) When restoring from a backup archive, place the archived `config.yaml` at `./config/config.yaml`.

The configuration contains credentials: keep it private and out of public repositories. Before updates, back up original files, indexes, configuration, and custom watermarks. See [storage and recovery](SCALABILITY.md) for consistent file and index backups.
