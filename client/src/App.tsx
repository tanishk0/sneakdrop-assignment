import { useState, useEffect, useCallback } from 'react';
import './App.css';

interface InventoryState {
  totalStock: number;
  availableStock: number;
  activeHoldsTotal: number;
  totalSold: number;
  waitingQueueTotal: number;
}

interface UserState {
  userId: string;
  activeHold: {
    id: string;
    expiresAt: string;
    secondsRemaining: number;
  } | null;
  queueEntry: {
    id: string;
    joinedAt: string;
    position: number;
  } | null;
  purchasesCount: number;
  canHold: boolean;
  canPurchase: boolean;
}

const PRESET_USERS = [
  { id: 'user_1', label: 'User 1 (Alice)' },
  { id: 'user_2', label: 'User 2 (Bob)' },
  { id: 'user_3', label: 'User 3 (Charlie)' },
  { id: 'user_4', label: 'User 4 (Dave)' },
  { id: 'user_5', label: 'User 5 (Eve)' },
];

export function App() {
  const [userId, setUserId] = useState<string>('user_1');
  const [customUserId, setCustomUserId] = useState<string>('');
  const [inventory, setInventory] = useState<InventoryState>({
    totalStock: 20,
    availableStock: 20,
    activeHoldsTotal: 0,
    totalSold: 0,
    waitingQueueTotal: 0,
  });
  const [userState, setUserState] = useState<UserState | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [notice, setNotice] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Fetch status from API
  const fetchStatus = useCallback(async () => {
    try {
      const activeUser = customUserId.trim() || userId;
      const res = await fetch(`/api/status?userId=${encodeURIComponent(activeUser)}`);
      if (!res.ok) return;
      const data = await res.json();
      setInventory(data.inventory);
      setUserState(data.userState);

      if (data.userState?.activeHold) {
        setSecondsRemaining(data.userState.activeHold.secondsRemaining);
      } else {
        setSecondsRemaining(null);
      }
    } catch (err) {
      console.error('Failed to fetch status:', err);
    }
  }, [userId, customUserId]);

  // Polling loop (every 1 second)
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 1000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Local seconds countdown tick
  useEffect(() => {
    if (secondsRemaining === null || secondsRemaining <= 0) return;
    const timer = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev === null || prev <= 1) {
          fetchStatus();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [secondsRemaining, fetchStatus]);

  // Handle Buy Click
  const handleBuy = async () => {
    setLoading(true);
    setNotice(null);
    try {
      const activeUser = customUserId.trim() || userId;
      const res = await fetch('/api/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: activeUser }),
      });
      const data = await res.json();

      if (!res.ok) {
        setNotice({ text: data.error || 'Failed to process request', type: 'error' });
      } else if (data.status === 'held') {
        setNotice({ text: 'Hold acquired! You have 5 minutes to complete payment.', type: 'success' });
        setSecondsRemaining(data.hold?.secondsRemaining || 300);
      } else if (data.status === 'queued') {
        setNotice({ text: `Stock is 0. You are #${data.position} in the waiting line.`, type: 'info' });
      }
      await fetchStatus();
    } catch (err: any) {
      setNotice({ text: err.message || 'Network error', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  // Handle Pay Click (Trigger simulated payment webhook)
  const handlePay = async (isLate = false) => {
    if (!userState?.activeHold?.id) return;
    setLoading(true);
    setNotice(null);
    try {
      const activeUser = customUserId.trim() || userId;
      const res = await fetch('/api/payment/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          holdId: userState.activeHold.id,
          userId: activeUser,
          isLate,
        }),
      });
      const data = await res.json();

      if (data.status === 'SUCCESS') {
        setNotice({ text: 'Payment succeeded! Purchase confirmed.', type: 'success' });
      } else if (data.status === 'REFUNDED') {
        setNotice({ text: `Payment rejected/refunded: ${data.message}`, type: 'error' });
      } else {
        setNotice({ text: data.message || 'Payment processed', type: 'info' });
      }
      await fetchStatus();
    } catch (err: any) {
      setNotice({ text: err.message || 'Payment failed', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  // Format seconds as mm:ss
  const formatTime = (totalSeconds: number | null) => {
    if (totalSeconds === null || totalSeconds < 0) return '00:00';
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const hasActiveHold = !!userState?.activeHold;
  const isQueued = !hasActiveHold && !!userState?.queueEntry;
  const isLimitReached = (userState?.purchasesCount ?? 0) >= 2;

  return (
    <div className="container">
      {/* Switcher for testing multiple users */}
      <div className="user-switch-bar">
        <label htmlFor="user-select">Test User: </label>
        <select
          id="user-select"
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setCustomUserId('');
            setNotice(null);
          }}
        >
          {PRESET_USERS.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="or custom user id"
          value={customUserId}
          onChange={(e) => {
            setCustomUserId(e.target.value);
            setNotice(null);
          }}
          className="custom-user-input"
        />
      </div>

      <div className="card">
        <h1 className="title">Sneaker Drop</h1>
        <div className="divider">─────────────</div>

        <div className="stock-line">
          Pairs left: <span className="highlight-stock">{inventory.availableStock}</span>
        </div>

        {/* Action Button */}
        <div className="action-section">
          {hasActiveHold ? (
            <button
              id="pay-button"
              className="btn btn-pay"
              onClick={() => handlePay(false)}
              disabled={loading}
            >
              {loading ? 'Processing...' : 'PAY NOW ($150)'}
            </button>
          ) : (
            <button
              id="buy-button"
              className="btn btn-buy"
              onClick={handleBuy}
              disabled={loading || isLimitReached || isQueued}
            >
              {loading
                ? 'Processing...'
                : isLimitReached
                ? 'PURCHASE LIMIT REACHED'
                : isQueued
                ? 'WAITING IN LINE'
                : inventory.availableStock > 0
                ? 'BUY'
                : 'JOIN WAITING LINE'}
            </button>
          )}
        </div>

        {/* Hold Countdown */}
        {hasActiveHold && (
          <div className="section">
            <div className="section-label">Your hold:</div>
            <div className="countdown-timer">{formatTime(secondsRemaining)} remaining</div>
          </div>
        )}

        {/* Queue Position */}
        {isQueued && (
          <div className="section">
            <div className="section-label">Queue position:</div>
            <div className="queue-position">#{userState?.queueEntry?.position}</div>
          </div>
        )}

        {/* Purchases Count */}
        <div className="section purchases-section">
          <div className="section-label">Purchases:</div>
          <div className="purchases-value">{userState?.purchasesCount ?? 0} / 2</div>
        </div>

        {/* Notice Message */}
        {notice && (
          <div className={`notice-box notice-${notice.type}`}>
            {notice.text}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
