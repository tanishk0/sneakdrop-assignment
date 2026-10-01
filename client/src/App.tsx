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

interface TestUser {
  id: string;
  label: string;
}

const INITIAL_USERS: TestUser[] = [
  { id: 'user_1', label: 'User 1 (Alice)' },
  { id: 'user_2', label: 'User 2 (Bob)' },
  { id: 'user_3', label: 'User 3 (Charlie)' },
  { id: 'user_4', label: 'User 4 (Dave)' },
  { id: 'user_5', label: 'User 5 (Eve)' },
];

export function App() {
  const [users, setUsers] = useState<TestUser[]>(INITIAL_USERS);
  const [buyerCount, setBuyerCount] = useState<number>(6);
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

  // Create a new buyer and select them
  const handleAddNewBuyer = () => {
    const nextId = `buyer_${buyerCount}`;
    const nextLabel = `Buyer #${buyerCount}`;
    setBuyerCount((prev) => prev + 1);
    setUsers((prev) => [...prev, { id: nextId, label: nextLabel }]);
    setUserId(nextId);
    setCustomUserId('');
    setNotice({ text: `Switched to newly created ${nextLabel} (${nextId})`, type: 'info' });
  };

  // 1-Click Buy with a brand new buyer (instantly tests stock count drop / exhaustion)
  const handleInstantBuyNewBuyer = async () => {
    setLoading(true);
    setNotice(null);
    try {
      const currentBuyerNum = buyerCount;
      const newId = `buyer_${currentBuyerNum}`;
      const newLabel = `Buyer #${currentBuyerNum}`;
      setBuyerCount((prev) => prev + 1);
      setUsers((prev) => [...prev, { id: newId, label: newLabel }]);
      setUserId(newId);
      setCustomUserId('');

      const res = await fetch('/api/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: newId }),
      });
      const data = await res.json();

      if (!res.ok) {
        setNotice({ text: data.error || 'Failed to process request', type: 'error' });
      } else if (data.status === 'held') {
        setNotice({
          text: `[${newLabel}] Hold acquired! Stock left: ${data.inventoryRemaining}`,
          type: 'success',
        });
        setSecondsRemaining(data.hold?.secondsRemaining || 300);
      } else if (data.status === 'queued') {
        setNotice({
          text: `[${newLabel}] Stock finished (0)! Placed at #${data.position} in waitlist queue.`,
          type: 'info',
        });
      }
      await fetchStatus();
    } catch (err: any) {
      setNotice({ text: err.message || 'Network error', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  // 1-Click Drain Stock to 0: Simulates multiple concurrent buyers to test 0 stock & waitlist immediately
  const handleDrainStock = async () => {
    if (inventory.availableStock <= 0) {
      setNotice({ text: 'Stock is already 0! Click "⚡ Instant Buy (New Buyer)" to test queue placement.', type: 'info' });
      return;
    }
    const needed = inventory.availableStock;
    setLoading(true);
    setNotice({ text: `Draining remaining ${needed} pairs with new buyers...`, type: 'info' });
    try {
      const startIdx = buyerCount;
      const newBuyers: TestUser[] = [];
      const requests = [];

      for (let i = 0; i < needed; i++) {
        const id = `buyer_${startIdx + i}`;
        newBuyers.push({ id, label: `Buyer #${startIdx + i}` });
        requests.push(
          fetch('/api/buy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: id }),
          })
        );
      }

      setBuyerCount(startIdx + needed);
      setUsers((prev) => [...prev, ...newBuyers]);
      // Select the last buyer created
      setUserId(`buyer_${startIdx + needed - 1}`);
      setCustomUserId('');

      await Promise.all(requests);
      await fetchStatus();
      setNotice({
        text: `Stock successfully finished! All ${needed} pairs reserved by new buyers. Next buyers will enter the waitlist queue.`,
        type: 'success',
      });
    } catch (err: any) {
      setNotice({ text: err.message || 'Failed to drain stock', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  // Reset inventory back to 20
  const handleReset = async () => {
    if (!window.confirm('Reset drop back to 20 available pairs? Current holds and queues will be cleared.')) return;
    setLoading(true);
    try {
      const res = await fetch('/api/reset', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setNotice({ text: 'Drop reset: 20 pairs restored, queue and holds cleared.', type: 'success' });
      } else {
        setNotice({ text: data.error || 'Failed to reset', type: 'error' });
      }
      await fetchStatus();
    } catch (err: any) {
      setNotice({ text: err.message || 'Reset failed', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  // Handle Buy Click for active user
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
      {/* Switcher & Add Buyer Bar */}
      <div className="user-switch-bar">
        <label htmlFor="user-select">User:</label>
        <select
          id="user-select"
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setCustomUserId('');
            setNotice(null);
          }}
        >
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="btn-add-buyer"
          onClick={handleAddNewBuyer}
          title="Create a new test buyer and select them"
        >
          + New Buyer
        </button>

        <input
          type="text"
          placeholder="or custom id"
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

        {/* Live Stock Display */}
        <div className="stock-line">
          <span>Pairs left:</span>
          <span className={`highlight-stock ${inventory.availableStock === 0 ? 'out-of-stock' : ''}`}>
            {inventory.availableStock > 0 ? inventory.availableStock : '0 (SOLD OUT)'}
          </span>
        </div>

        {/* System metrics snapshot */}
        <div className="system-stats">
          <div className="stat-item">
            <span className="stat-label">Active Holds</span>
            <span className="stat-val">{inventory.activeHoldsTotal}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">In Waitlist</span>
            <span className="stat-val">{inventory.waitingQueueTotal}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Total Sold</span>
            <span className="stat-val">{inventory.totalSold}</span>
          </div>
        </div>

        {/* Main Action Button for Active User */}
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

        {/* Quick Testing Toolkit */}
        <div className="quick-test-panel">
          <div className="quick-test-header">
            <span className="quick-test-title">⚡ Testing Toolkit (Stock & Queue)</span>
          </div>
          <div className="quick-test-actions">
            <button
              type="button"
              className="btn-test btn-test-primary"
              onClick={handleInstantBuyNewBuyer}
              disabled={loading}
            >
              ⚡ Instant Buy (New Buyer)
            </button>
            <div className="test-sub-actions">
              <button
                type="button"
                className="btn-test btn-test-drain"
                onClick={handleDrainStock}
                disabled={loading || inventory.availableStock <= 0}
                title="Create buyers to reserve all remaining stock down to 0"
              >
                🔥 Drain Stock ({inventory.availableStock} left)
              </button>
              <button
                type="button"
                className="btn-test btn-test-reset"
                onClick={handleReset}
                disabled={loading}
                title="Reset database to 20 stock"
              >
                🔄 Reset (20 pairs)
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
