let guard: (() => boolean) | null = null;
export function setNavigationGuard(next: () => boolean) { guard = next; return () => { if (guard === next) guard = null; }; }
export function canNavigate() { return !guard || guard(); }
