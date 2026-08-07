// Accumu v2 — 알림 팝업 (마이그레이션 20260806120000 / docs/specs/notifications-calendar.md)
//
// [이 화면은 알림을 만들지 않는다] 행은 DB 트리거만 만든다(insert 정책 0개). 여기서 하는 쓰기는
//   "모두 읽음"(mark_notifications_read RPC) 하나뿐이고, 그마저 is_read 만 바꾼다.
//
// [원칙 1 — 게임화 금지] 연속 참여·달성률·순위를 표시하지 않는다. 알림은 일어난 일을 시간순으로
//   적을 뿐이고, 안 읽음 표시는 점 하나다. 개수 배지도 종 아이콘에만 있다.
//
// [읽음 처리 — 2026-08-08 뒤집힘] 스펙(notifications-calendar.md 화면 A)은 "자동 읽음 처리를 하지
//   않는다"였고 근거는 "열자마자 사라지는 표시는 뭘 놓쳤는지 확인할 기회를 빼앗는다"였다.
//   케빈 요청으로 뒤집는다: 버튼을 하나 더 누르게 하는 비용이 그 이득보다 컸다.
//   대신 근거를 이렇게 살린다 — **읽음은 표시만 바꾸고 목록은 그대로 둔다.** 이번에 연 팝업에서는
//   방금 읽힌 것들이 계속 보이고(unreadIds 로 고정), 사라지는 것은 종 아이콘의 배지뿐이다.
//
// [학생·관리자가 같은 컴포넌트를 쓴다 — ADR 0013] 알림 조회에 역할 분기가 없다. 누구의 알림인지는
//   RLS(recipient_id = auth.uid())가 정하므로 화면은 "내 알림"만 알면 된다.
import { useEffect, useState } from 'react';
import Modal from '../Modal';
import Icon from '../Icon';
import { fetchMyNotifications, markNotificationsRead } from '../../lib/notificationService';
import '../../styles/Notifications.css';

/** 알림 종류별 아이콘·색 (프로토타입 NOTIF_IC/COLOR/SOFT, 1139~1141줄 + ADR 0013 신규 4종). */
const LOOK = {
  // 학생
  new: { icon: 'ic-compass', color: 'var(--brand)', soft: 'var(--brand-soft)' },
  apply: { icon: 'ic-qr', color: 'var(--indigo)', soft: 'var(--indigo-soft)' },
  enter: { icon: 'ic-check', color: 'var(--brand)', soft: 'var(--brand-soft)' },
  exit: { icon: 'ic-coin', color: 'var(--amber)', soft: 'var(--amber-soft)' },
  convert: { icon: 'ic-coin', color: 'var(--amber)', soft: 'var(--amber-soft)' },
  upcoming: { icon: 'ic-calendar', color: 'var(--brand)', soft: 'var(--brand-soft)' },
  // 할 일이 남은 상태다. rose(거부/실패)가 아니라 amber(주의) — .pf-msg.warn 이 세운 뜻 그대로.
  exit_due: { icon: 'ic-qr', color: 'var(--amber)', soft: 'var(--amber-soft)' },
  // 관리자 (ADR 0013). 전부 관리자 기능 3종에 관한 사실이다 — 그 밖의 종류를 늘리지 말 것.
  apply_admin: { icon: 'ic-user', color: 'var(--indigo)', soft: 'var(--indigo-soft)' },
  mentee: { icon: 'ic-school', color: 'var(--brand)', soft: 'var(--brand-soft)' },
  upcoming_admin: { icon: 'ic-calendar', color: 'var(--brand)', soft: 'var(--brand-soft)' },
  // "내려도 괜찮아요" 는 오류가 아니라 정리 권유다 — rose(거부/실패)를 쓰지 않는다.
  stale: { icon: 'ic-calendar', color: 'var(--ink2)', soft: 'var(--bg2)' },
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
  // 팝업을 연 시점에 "안 읽음"이었던 id 들. 읽음 처리 뒤에도 이 팝업 안에서는 계속 강조해 보여준다 —
  // 자동 읽음의 유일한 단점("열자마자 표시가 사라져 뭘 놓쳤는지 모른다")을 이 한 줄이 막는다.
  const [unreadIds, setUnreadIds] = useState(() => new Set());

  useEffect(() => {
    let alive = true;
    (async () => {
      let data;
      try {
        data = await fetchMyNotifications();
      } catch (err) {
        console.error('[NotifPopup] 알림 조회 실패:', err);
        if (alive) {
          setRows([]);
          setError('알림을 불러오지 못했어요.');
        }
        return;
      }
      if (!alive) return;
      setRows(data);
      setUnreadIds(new Set(data.filter((n) => !n.is_read).map((n) => n.id)));

      // [열면 읽음 — 2026-08-08] ★ 조회에 성공해 목록을 그린 뒤에만 읽음 처리한다.
      //   순서를 바꾸면(먼저 읽음 -> 조회 실패) 사용자는 보지도 못한 알림을 잃는다.
      if (data.some((n) => !n.is_read)) {
        try {
          await markNotificationsRead();
          onReadChange?.(); // 종 아이콘 배지를 즉시 지운다
        } catch (err) {
          // 읽음 실패는 화면을 막지 않는다 — 목록은 이미 보이고, 다음에 열 때 다시 시도된다.
          console.warn('[NotifPopup] 읽음 처리 실패(다음에 재시도):', err);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // onReadChange 는 셸의 useCallback 이라 안정적이다 — 의존성에 넣어도 재조회가 반복되지 않는다.
  }, [onReadChange]);

  return (
    <Modal onClose={onClose} labelledBy="notif-title" closeAbove>
      <div className="mbody">
        <div className="pop-head">
          {/* [모두 읽음 버튼이 없다 — 2026-08-08 케빈 요청] 팝업을 여는 것이 곧 읽음이라 누를 것이 없다. */}
          <h3 id="notif-title">알림</h3>
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
              // is_read 가 아니라 unreadIds 로 판정한다 — 방금 읽힌 것도 이 팝업에서는 계속 강조된다.
              return (
                <div key={n.id} className={unreadIds.has(n.id) ? 'nf unread' : 'nf'}>
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
