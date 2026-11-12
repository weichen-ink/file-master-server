const MONITOR_SECTIONS = ['service', 'resources', 'storage', 'files', 'backup'];
function normalizeMonitoring(value = {}) {
  return {
    enabled: value?.enabled === true,
    sections: Object.fromEntries(MONITOR_SECTIONS.map(key => [key, typeof value?.sections?.[key] === 'boolean' ? value.sections[key] : key === 'service']))
  };
}
function validateMonitoring(value) {
  const object = item => item && typeof item === 'object' && !Array.isArray(item);
  if (!object(value)) throw new Error('Monitoring must be a key-value object');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('Monitoring enabled must be true or false');
  if (value.sections !== undefined && (!object(value.sections) || Object.entries(value.sections).some(([key, enabled]) => !MONITOR_SECTIONS.includes(key) || typeof enabled !== 'boolean'))) throw new Error('Invalid monitoring output selection');
}
module.exports = { MONITOR_SECTIONS, normalizeMonitoring, validateMonitoring };
