// Accumu v2 — 학생 공통 셸 (docs/specs/student-home.md "A. 상단 공통 셸")
// Accumu_prototype.html <nav class="nav">(530~547줄) + <nav class="bottomnav">(670~675줄) 재현.
// 이후 모든 학생 화면이 이 셸 안에서 렌더된다 (src/routes/StudentLayout.jsx).
import { useCallback, useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Icon from '../Icon';
import NotifPopup from './NotifPopup';
import CalendarPopup from './CalendarPopup';
import { fetchUnreadCount, syncMyNotices } from '../../lib/notificationService';
import '../../styles/StudentShell.css';

// 데스크톱 상단 메뉴 (모바일 ≤768px에서는 숨기고 하단 탭바로 대체)
const MENU = [
  { to: '/student/programs', icon: 'ic-compass', label: '프로그램' },
  { to: '/student/archive', icon: 'ic-folder', label: '디지털 아카이브' },
  { to: '/student/mypage', icon: 'ic-user', label: '마이페이지' },
];

// 모바일 하단 탭바 4개 (CLAUDE.md 8장)
const TABS = [
  { to: '/student', icon: 'ic-home', label: '홈', end: true },
  { to: '/student/programs', icon: 'ic-compass', label: '프로그램' },
  { to: '/student/archive', icon: 'ic-folder', label: '아카이브' },
  { to: '/student/mypage', icon: 'ic-user', label: '마이' },
];

const navClass = ({ isActive }) => (isActive ? 'on' : undefined);

export default function StudentShell({ children }) {
  const { profile } = useAuth();
  const navigate = useNavigate();
  // 'notif' | 'calendar' | null
  const [popup, setPopup] = useState(null);
  const [unread, setUnread] = useState(0);

  const points = profile?.points_balance ?? 0;
  const initial = profile?.name?.trim()?.[0] ?? '';

  // [배지는 개수만 읽는다] 목록은 팝업이 열릴 때 조회한다. 셸이 전체 목록을 들고 있으면
  // 모든 학생 화면이 알림 데이터에 묶인다 — 셸은 "안 읽은 게 있는가"만 알면 된다.
  const refreshUnread = useCallback(() => {
    if (!profile?.id) return;
    fetchUnreadCount()
      .then(setUnread)
      .catch((err) => console.error('[StudentShell] 안 읽은 알림 조회 실패:', err));
  }, [profile?.id]);

  // [상태형 알림은 여기서 계산한다 — ADR 0013 / 마이그레이션 20260808140000]
  //   "내일 참여 예정"(upcoming) / "퇴장 인증이 남았다"(exit_due) 는 사건이 아니라 시간이 지나면 참이
  //   되는 상태라 트리거가 깨어날 계기가 없다. 서버가 멱등이라 마운트마다 불러도 안전하다.
  //   관리자 셸과 **같은 함수**를 부른다 — 역할 판정은 서버가 한다.
  //   실패해도 셸은 그대로 뜬다.
  useEffect(() => {
    if (!profile?.id) return;
    (async () => {
      try {
        await syncMyNotices();
      } catch (err) {
        console.warn('[StudentShell] 상태형 알림 동기화 실패(표시만 지연됨):', err);
      }
      refreshUnread();
    })();
  }, [profile?.id, refreshUnread]);

  // 팝업이 닫힐 때도 다시 센다 — QR 퇴장 인증처럼 다른 화면에서 알림이 생겼을 수 있다.
  useEffect(() => {
    refreshUnread();
  }, [refreshUnread, popup]);

  return (
    <>
      <nav className="nav">
        <div className="logo" onClick={() => navigate('/student')} role="link" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') navigate('/student'); }}>
          <Icon name="ic-logo" width={30} height={28} />
          <span className="word">
            Accu<b>mu</b>
          </span>
        </div>

        <div className="menu">
          {MENU.map((m) => (
            <NavLink key={m.to} to={m.to} className={navClass}>
              <Icon name={m.icon} size={18} />
              {m.label}
            </NavLink>
          ))}
        </div>

        <div className="spacer" />

        <button type="button" className="bell" onClick={() => setPopup('calendar')} aria-label="활동 캘린더">
          <Icon name="ic-calendar" size={22} />
        </button>
        <button
          type="button"
          className="bell"
          onClick={() => setPopup('notif')}
          aria-label={unread > 0 ? `알림 ${unread}건` : '알림'}
        >
          <Icon name="ic-bell" size={22} />
          {/* 확정 C 가 dot 을 금지했던 이유는 "근거 없는 가짜 표시"였다. 이제 실제 개수를 세므로
              그 전제가 사라졌다. 9를 넘으면 9+ — 정확한 숫자를 키울 이유가 없다(원칙 1). */}
          {unread > 0 && <span className="ndot">{unread > 9 ? '9+' : unread}</span>}
        </button>

        {/* 포인트는 나브 우측 구석에 작게/절제해서만 (절대 원칙 4 — 홈에 큰 잔액 배너 금지).
            아바타는 정적 이니셜이며 레벨/성장 요소가 아니다 (게임화 금지). */}
        <div className="me">
          <div className="pts" title="사용 가능한 포인트">
            <Icon name="ic-coin" size={18} color="var(--amber)" />
            <span>{points.toLocaleString()}</span>
            <em>P</em>
          </div>
          <div className="av" aria-hidden="true">{initial}</div>
        </div>
      </nav>

      <div className="wrap">{children}</div>

      <nav className="bottomnav">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={navClass}>
            <Icon name={t.icon} size={22} />
            <span>{t.label}</span>
          </NavLink>
        ))}
      </nav>

      {popup === 'calendar' && <CalendarPopup onClose={() => setPopup(null)} />}
      {popup === 'notif' && (
        <NotifPopup onClose={() => setPopup(null)} onReadChange={refreshUnread} />
      )}
    </>
  );
}
