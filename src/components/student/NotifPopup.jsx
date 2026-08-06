// Accumu v2 — 알림 팝업 (마이그레이션 20260806120000 / docs/specs/notifications-calendar.md)
//
// [이 화면은 알림을 만들지 않는다] 행은 DB 트리거만 만든다(insert 정책 0개). 여기서 하는 쓰기는
//   "모두 읽음"(mark_notifications_read RPC) 하나뿐이고, 그마저 is_read 만 바꾼다.
//
// [원칙 1 — 게임화 금지] 연속 참여·달성률·순위를 표시하지 않는다. 알림은 일어난 일을 시간순으로
//   적을 뿐이고, 안 읽음 표시는 점 하나다. 개수 배지도 종 아이콘에만 있다.
//
// [프로토타입과 다른 점] 프로토타입은 팝업을 열고 1초 뒤 자동으로 전부 읽음 처리했다(1156줄).
//   여기서는 자동으로 읽지 않는다 — 열자마자 사라지는 표시는 "내가 뭘 놓쳤는지"를 확인할 기회를
//   빼앗는다. 읽음은 사용자가 "모두 읽음"을 누를 때만 일어난다.
import { useEffect, useState } from 'react';
import Modal from '../Modal';
import Icon from '../Icon';
import { fetchMyNotifications, markNotificationsRead } from '../../lib/notificationService';
import '../../styles/Notifications.css';

/** 알림 종류별 아이콘·색 (프로토타입 NOTIF_IC/COLOR/SOFT, 1139~1141줄). */
const LOOK = {
  new: { icon: 'ic-compass', color: 'var(--brand)', soft: 'var(--brand-soft)' },
  apply: { icon: 'ic-qr', color: 'var(--indigo)', soft: 'var(--indigo-soft)' },
  enter: { icon: 'ic-check', color: 'var(--brand)', soft: 'var(--brand-soft)' },
  exit: { icon: 'ic-coin', color: 'var(--amber)', soft: 'var(--amber-soft)' },
};
const lookOf = (type) => LOOK[type] ?? { icon: 'ic-bell', color: 'var(--brand)', soft: 'var(--brand-soft)' };

/**
 * 상대 시각. '방금 전' / 'N분 전' / 'N시간 전' / '어제' / 'M월 D일'.
 * 프로토타입은 문자열이 하드코딩돼 있었지만(time:'1시간 전') 여기서는 created_at 으로 계산한다.
 */
function relTime(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  if (hr < 48) return '어제';
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

export default function NotifPopup({ onClose, onReadChange }) {
  const [rows, setRows] = useState(null); // null = 로딩 중
  const [error, setError] = useState('');
  const [marking, setMarking] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchMyNotifications()
      .then((data) => alive && setRows(data))
      .catch((err) => {
        console.error('[NotifPopup] 알림 조회 실패:', err);
        if (alive) {
          setRows([]);
          setError('알림을 불러오지 못했어요.');
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const unread = (rows ?? []).filter((n) => !n.is_read).length;

  async function handleReadAll() {
    if (marking || unread === 0) return;
    setMarking(true);
    try {
      await markNotificationsRead();
      // 서버가 성공했으므로 화면도 같은 상태로 맞춘다. 재조회는 필요 없다(바뀐 값이 is_read 하나뿐).
      setRows((prev) => (prev ?? []).map((n) => ({ ...n, is_read: true })));
      onReadChange?.();
    } catch (err) {
      console.error('[NotifPopup] 읽음 처리 실패:', err);
      setError('읽음 처리에 실패했어요.');
    } finally {
      setMarking(false);
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="notif-title">
      <div className="mbody">
        <div className="pop-head">
          <h3 id="notif-title">알림</h3>
          <button type="button" className="readall" onClick={handleReadAll} disabled={marking || unread === 0}>
            {marking ? '처리 중…' : '모두 읽음'}
          </button>
        </div>

        {rows === null && <div className="empty">불러오는 중…</div>}

        {rows !== null && rows.length === 0 && (
          <div className="empty">
            {error || '새로운 알림이 없습니다.'}
          </div>
        )}

        {rows !== null && rows.length > 0 && (
          <div className="notiflist">
            {rows.map((n) => {
              const look = lookOf(n.type);
              return (
                <div key={n.id} className={n.is_read ? 'nf' : 'nf unread'}>
                  <div className="nic" style={{ background: look.soft }}>
                    <Icon name={look.icon} size={20} color={look.color} />
                  </div>
                  <div className="ninfo">
                    <h5>{n.message}</h5>
                    {n.detail && <div className="nb">{n.detail}</div>}
                    <div className="nt">{relTime(n.created_at)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
