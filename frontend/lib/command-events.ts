/**
 * Window CustomEvents that global shortcuts send to whichever component owns the action
 * (⌘K → model picker, ⌘D → dictation). Several instances may be mounted at once (the
 * composer dock and a question dock, for example), so exactly one target is chosen:
 * the first that *claims* the command (e.g. it holds focus or is already active), else
 * the most recently mounted eligible one.
 */

export const OPEN_MODEL_PICKER_EVENT = "learnharness:open-model-picker";
export const TOGGLE_DICTATION_EVENT = "learnharness:toggle-dictation";

export interface CommandTarget {
  run: () => void;
  /** Whether this instance can take the command now (mounted, visible, enabled). */
  eligible?: () => boolean;
  /** Whether this instance should win over the others (focus inside, already active). */
  claims?: () => boolean;
}

/** Pure choice among registered targets (registration order = mount order). */
export function pickCommandTarget<T extends CommandTarget>(targets: readonly T[]): T | null {
  const eligible = targets.filter((t) => (t.eligible ? t.eligible() : true));
  for (let i = eligible.length - 1; i >= 0; i--) if (eligible[i].claims?.()) return eligible[i];
  return eligible.length ? eligible[eligible.length - 1] : null;
}

const registries = new Map<string, CommandTarget[]>();

/** Register a target for `event`; installs one window listener per event name. Returns the unregister function. */
export function registerCommandTarget(event: string, target: CommandTarget): () => void {
  let list = registries.get(event);
  if (!list) {
    list = [];
    registries.set(event, list);
    const targets = list;
    window.addEventListener(event, () => pickCommandTarget(targets)?.run());
  }
  list.push(target);
  return () => {
    const current = registries.get(event);
    const index = current ? current.indexOf(target) : -1;
    if (current && index >= 0) current.splice(index, 1);
  };
}

export function dispatchCommand(event: string): void {
  window.dispatchEvent(new CustomEvent(event));
}
