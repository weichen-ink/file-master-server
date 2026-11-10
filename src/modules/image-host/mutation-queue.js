const { createTaskQueue } = require('../../core/task-queue');

/** All asset-mutating requests run one at a time so index, files and caches stay consistent. */
const mutateAssets = createTaskQueue(1);

const serializeMutation = (handler) => (req, res) => mutateAssets(() => handler(req, res))
  .catch((err) => res.status(err.status || 500).json({ error: err.message }));

module.exports = { mutateAssets, serializeMutation };
