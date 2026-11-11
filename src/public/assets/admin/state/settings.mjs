/**
 * @typedef {Object} SectionState
 * @property {Object} baseline Last acknowledged server snapshot.
 * @property {Object} draft Independent in-memory form values; may contain secrets.
 * @property {Object} errors Field validation messages.
 * @property {boolean} saving Blocks duplicate submissions across page mounts.
 */
const clone = (value) => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Owns drafts independently of page mounts and status polling. Secrets never enter browser storage. */
export function createSettingsStore() {
  const sections = new Map();
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn());
  return {
    subscribe(fn) {
      listeners.add(fn);
      fn();
      return () => listeners.delete(fn);
    },
    setSaving(name, saving) {
      const s = sections.get(name);
      if (s) s.saving = saving;
      emit();
    },
    dirtyNames() {
      return [...sections.keys()].filter((name) => this.dirty(name));
    },
    section(name, initial) {
      if (!sections.has(name))
        sections.set(name, {
          baseline: clone(initial),
          draft: clone(initial),
          errors: {},
          saving: false,
        });
      return sections.get(name);
    },
    dirty(name) {
      const s = sections.get(name);
      return Boolean(s && !equal(s.baseline, s.draft));
    },
    anyDirty() {
      return [...sections.keys()].some((name) => this.dirty(name));
    },
    edit(name, key, value) {
      const s = sections.get(name);
      s.draft[key] = value;
      delete s.errors[key];
      emit();
    },
    discard(name) {
      const s = sections.get(name);
      s.draft = clone(s.baseline);
      s.errors = {};
      emit();
    },
    accept(name, saved) {
      const s = sections.get(name);
      s.baseline = clone(saved);
      s.draft = clone(saved);
      s.errors = {};
      emit();
    },
    merge(name, saved) {
      const s = sections.get(name);
      if (s && !this.dirty(name)) this.accept(name, saved);
    },
    clear() {
      sections.clear();
      emit();
    },
  };
}

export async function confirmedMutation(operation, commit) {
  const result = await operation();
  commit(result);
  return result;
}
