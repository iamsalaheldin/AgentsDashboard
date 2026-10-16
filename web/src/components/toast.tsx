import { useSyncExternalStore } from 'react';
import { OctagonAlert, CircleCheck } from 'lucide-react';

interface Toast {
  id: number;
  kind: 'success' | 'error';
  text: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(kind: Toast['kind'], text: string) {
  const id = nextId++;
  toasts = [...toasts, { id, kind, text }].slice(-4);
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, 3500);
}

export function Toaster() {
  const list = useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => toasts,
  );
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="panel pointer-events-auto flex items-center gap-2 px-3 py-2 text-[12px] shadow-lg shadow-black/40">
          {t.kind === 'success' ? <CircleCheck size={14} className="text-st-working" /> : <OctagonAlert size={14} className="text-st-error" />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
