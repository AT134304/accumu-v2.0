// Accumu v2 — 학생 공통 셸 (docs/specs/student-home.md "A. 상단 공통 셸")
// Accumu_prototype.html <nav class="nav">(530~547줄) + <nav class="bottomnav">(670~675줄) 재현.
// 이후 모든 학생 화면이 이 셸 안에서 렌더된다 (src/routes/StudentLayout.jsx).
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Icon from '../Icon';
import Modal from '../Modal';
import { fmtDate, monthTitle, todayISO } from '../../lib/date';
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
  // 'notif' | 'calendar' | null — 확정 C: 아이콘 + 빈 상태 팝업(껍데기)
  const [popup, setPopup] = useState(null);

  const points = profile?.points_balance ?? 0;
  const initial = profile?.name?.trim()?.[0] ?? '';

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
        <button type="button" className="bell" onClick={() => setPopup('notif')} aria-label="알림">
          <Icon name="ic-bell" size={22} />
          {/* 안 읽은 알림 dot(.ndot)은 notifications 테이블 도입 시 연결한다.
              지금 dot을 띄우면 근거 없는 가짜 표시가 된다 (확정 C: 조회 금지). */}
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
      {popup === 'notif' && <NotifPopup onClose={() => setPopup(null)} />}
    </>
  );
}

/**
 * 활동 캘린더 — 빈 상태 팝업 (확정 C).
 * 월별 뷰/일정 데이터는 participations 도입 시 별도 스펙. 지금은 기준일만 실제 오늘로 보여준다.
 * 프로토타입 TODAY_ISO='2026-07-02' 하드코딩은 쓰지 않는다 (CLAUDE.md 9장).
 */
function CalendarPopup({ onClose }) {
  const now = new Date(); // 팝업을 열 때마다 실제 오늘을 다시 읽는다.
  return (
    <Modal onClose={onClose} labelledBy="cal-title">
      <div className="mbody">
        <div className="calhead">
          <h3 id="cal-title">{monthTitle(now)}</h3>
        </div>
        <div className="cal-today">오늘 · {fmtDate(todayISO(now))}</div>
        <div className="empty">
          이 달에는 나의 활동 기록이 없어요.
          <br />
          활동에 참여하면 이곳에 일정이 표시됩니다.
        </div>
      </div>
    </Modal>
  );
}

/** 알림 — 빈 상태 팝업 (확정 C). notifications 테이블이 없어 조회하지 않는다. */
function NotifPopup({ onClose }) {
  return (
    <Modal onClose={onClose} labelledBy="notif-title">
      <div className="mbody">
        <h3 id="notif-title">알림</h3>
        {/* 빈 상태 문구는 프로토타입 1150줄 카피 그대로 */}
        <div className="empty">새로운 알림이 없습니다.</div>
      </div>
    </Modal>
  );
}
