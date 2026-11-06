import { useEffect, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { ToolApprovalRequest } from '../../electron/types';

export function useToolApprovals() {
  const [requests, setRequests] = useState<ToolApprovalRequest[]>([]);

  useEffect(() => {
    const offReq = ipc.onToolApprovalRequest((req) => {
      setRequests((rs) => [...rs.filter((r) => r.id !== req.id), req]);
    });
    const offCleared = ipc.onToolApprovalCleared((id) => {
      setRequests((rs) => rs.filter((r) => r.id !== id));
    });
    return () => {
      offReq();
      offCleared();
    };
  }, []);

  const decide = (id: string, approved: boolean) => {
    window.spirit?.respondToolApproval?.(id, approved);
    setRequests((rs) => rs.filter((r) => r.id !== id));
  };

  const clearAll = () => setRequests([]);

  return { requests, decide, clearAll };
}
