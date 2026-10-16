import { useEffect } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router';
import { LoaderCircle } from 'lucide-react';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { Shell } from './components/layout.tsx';
import { Toaster } from './components/toast.tsx';
import { connect, useBackend, useMission } from './lib/store.ts';
import { ActivityPage } from './pages/ActivityPage.tsx';
import { Agents } from './pages/Agents.tsx';
import { Attention } from './pages/Attention.tsx';
import { Overview } from './pages/Overview.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { WorkspaceDetail } from './pages/WorkspaceDetail.tsx';
import { Workspaces } from './pages/Workspaces.tsx';

function Pages() {
  const m = useMission();
  const backend = useBackend();
  const loc = useLocation();
  if (!m) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-[12px] text-ink-3" data-testid="loading">
        <LoaderCircle size={18} className="animate-spin text-accent" />
        {backend === 'lost' ? 'Cannot reach the Mission Control backend. Is `npm start` running?' : 'Loading Mission Control…'}
      </div>
    );
  }
  return (
    <ErrorBoundary resetKey={loc.pathname}>
      <Routes>
        <Route path="/" element={<Overview m={m} />} />
        <Route path="/workspaces" element={<Workspaces m={m} />} />
        <Route path="/workspaces/:id" element={<WorkspaceDetail m={m} />} />
        <Route path="/agents" element={<Agents m={m} />} />
        <Route path="/attention" element={<Attention m={m} />} />
        <Route path="/activity" element={<ActivityPage m={m} />} />
        <Route path="/settings" element={<SettingsPage m={m} />} />
        <Route path="*" element={<div className="text-ink-3">Page not found.</div>} />
      </Routes>
    </ErrorBoundary>
  );
}

export function App() {
  useEffect(() => connect(), []);
  return (
    <BrowserRouter>
      <Shell>
        <Pages />
      </Shell>
      <Toaster />
    </BrowserRouter>
  );
}
