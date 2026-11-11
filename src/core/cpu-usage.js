const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');

// CPU utilization comes from elapsed busy/idle ticks, not the OS run-queue load average.
function cpuUsageBetween(before, after) {
  if (!before.length || before.length !== after.length) return null;
  let total = 0, idle = 0;
  for (let i = 0; i < before.length; i++) {
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq']) {
      const delta = after[i].times[key] - before[i].times[key];
      if (!Number.isFinite(delta) || delta < 0) return null;
      total += delta;
      if (key === 'idle') idle += delta;
    }
  }
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : null;
}
async function sampleCpuUsage() {
  const before = os.cpus();
  await delay(200);
  return cpuUsageBetween(before, os.cpus());
}
module.exports = { cpuUsageBetween, sampleCpuUsage };
