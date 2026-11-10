/** A bounded, process-local queue. Rejections never stop later work. */
function createTaskQueue(concurrency, maxPending = 128) {
  let active = 0;
  const pending = [];
  function drain() {
    while (active < concurrency && pending.length) {
      const { task, resolve, reject } = pending.shift();
      active++;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        active--;
        drain();
      });
    }
  }
  return (task) => new Promise((resolve, reject) => {
    if (pending.length >= maxPending) {
      reject(Object.assign(new Error('Server is busy; retry shortly'), { status: 503 }));
      return;
    }
    pending.push({ task, resolve, reject });
    drain();
  });
}

module.exports = { createTaskQueue };
