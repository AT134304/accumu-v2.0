// Accumu v2 — 관리자 공통 셸 (docs/specs/qr-dual-auth.md "C. 관리자 — 공통 셸", 확정 G-3 1단계분)
//
// 학생 셸(StudentShell)의 시각 언어를 그대로 따르되 두 가지를 **의도적으로 넣지 않는다**:
//   - 포인트 표시: 관리자에게 포인트 개념이 없다(스펙 C절).
//   - 참여자 수·출석률·랭킹·학교 통계: 원칙 1·6. 애초에 관리자에게 그 데이터를 주는 RLS 정책이 없다.
//
// [알림·캘린더 — 2026-08-08 추가, ADR 0013]
//   원래 이 자리에는 "관리자용 이벤트 소스가 없다"고 적혀 있었다. 이제 있다(내 프로그램에 신청,
//   담당 학생 추가, 일정이 지난 게시중 프로그램).
//   원칙 6 은 지켜진다 — 관리자 기능 3종은 **동작**이고, 이 둘은 그 3종에 관한 **읽기**다.
//   메뉴(MENU) 항목이 4개 그대로이고 관리자가 새로 할 수 있게 된 일이 0개다.
//   >>> 알림 종류가 3종 기능 밖의 사실을 나르거나 이 팝업에 액션 버튼이 붙으면 그때가 위반이다.
//
// [로그아웃] 기존 AdminHomePage 63줄 골격의 유일한 기능이었다. 홈이 실제 화면으로 바뀌면서 갈 곳을 잃지 않도록
//   여기(셸 우측)로 옮긴다. 1인 시연에서 학생/관리자 계정을 오가는 필수 경로다.
//
// [StudentShell.css 를 함께 import 하는 이유] 그 파일은 학생 전용이 아니라 앱 공통 시각 언어
//   (.nav / .wrap / .bottomnav / .screen / .empty / .overlay / .modal)를 담고 있다. 관리자 셸도 같은 언어를 쓴다.
//   200줄을 복제하면 두 셸이 시간이 지나며 어긋난다.
import { useCallback, useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Icon from '../Icon';
import NotifPopup from '../student/NotifPopup';
import AdminCalendarPopup from './AdminCalendarPopup';
import { fetchUnreadCount, syncMyNotices } from '../../lib/notificationService';
import '../../styles/StudentShell.css';
import '../../styles/AdminShell.css';

// 관리자 기능 3종(CLAUDE.md 2장 6번) + 홈. **항목 수는 4개로 고정** — 늘리지 말 것(원칙 6).
//
// [담당 학생 -> 마이페이지 (docs/specs/admin-students.md 결정 M)]
//   화면의 주제가 "학생"에서 "관리자 본인(계정 + 담당 학생 아카이브)"으로 바뀌어 라벨·경로·아이콘을 맞췄다.
//   기능이 추가된 게 아니라 배치가 바뀐 것이다 — 관리자가 할 수 있는 동작은 3종 그대로다.
//   ic-folder 는 마이페이지 안의 "담당 학생 아카이브" 섹션 헤더로 내려갔고 ic-user 는 학생 셸의
//   마이페이지와 대칭이다(신규 아이콘 0개).
//
// [end 를 붙이지 않는다] 상세(/admin/mypage/students/:id)에서도 "마이페이지" 메뉴가 활성으로 유지된다.
//   형제 경로로 쪼갰다면 상세에서 활성 메뉴가 사라져 "내가 어디 있는지" 신호를 잃는다.
// short 는 모바일 하단 탭바 전용 라벨이다. 상단 메뉴는 폭이 넉넉해 긴 이름이 낫지만,
// 하단은 4열을 나눠 쓰므로 "프로그램 관리"가 좁은 화면(≤360px)에서 두 줄로 접혀 그 탭만 높아진다.
// 학생 셸이 TABS 를 따로 둔 것과 같은 해법이다(StudentShell.jsx 20줄).
const MENU = [
  { to: '/admin', icon: 'ic-home', label: '홈', end: true },
  { to: '/admin/scan', icon: 'ic-qr', label: 'QR 스캔', short: 'QR' },
  { to: '/admin/programs', icon: 'ic-compass', label: '프로그램 관리', short: '프로그램' },
  { to: '/admin/mypage', icon: 'ic-user', label: '마이페이지', short: '마이' },
];

const navClass = ({ isActive }) => (isActive ? 'on' : undefined);

export default function AdminShell({ children }) {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();

  // 'notif' | 'calendar' | null
  const [popup, setPopup] = useState(null);
  const [unread, setUnread] = useState(0);

  const initial = profile?.name?.trim()?.[0] ?? '';

  // [셸은 개수만 안다] 목록은 팝업이 열릴 때 조회한다 — 학생 셸과 같은 규율.
  const refreshUnread = useCallback(() => {
    if (!profile?.id) return;
    fetchUnreadCount()
      .then(setUnread)
      .catch((err) => console.error('[AdminShell] 안 읽은 알림 조회 실패:', err));
  }, [profile?.id]);

  // [상태형 알림은 여기서 계산한다 — ADR 0013]
  //   "일정이 지났다"(stale) / "내일 진행이다"(upcoming_admin) 는 사건이 아니라 시간이 지나면 참이 되는
  //   상태다. 트리거는 행이 바뀔 때만 깨어나므로 아무도 건드리지 않는 프로그램에서는 영원히 발화하지 않는다.
  //   서버가 멱등이라 셸이 마운트될 때마다 불러도 안전하다.
  //   실패해도 셸은 그대로 뜬다 — 알림 하나 때문에 관리자 화면 전체가 죽으면 안 된다.
  useEffect(() => {
    if (!profile?.id) return;
    (async () => {
      try {
        await syncMyNotices();
      } catch (err) {
        console.warn('[AdminShell] 상태형 알림 동기화 실패(표시만 지연됨):', err);
      }
      refreshUnread();
    })();
  }, [profile?.id, refreshUnread]);

  // 팝업이 닫힐 때도 다시 센다 — 다른 화면에서 알림이 생겼을 수 있다.
  useEffect(() => {
    refreshUnread();
  }, [refreshUnread, popup]);

  return (
    <>
      <nav className="nav">
        <div
          className="logo"
          onClick={() => navigate('/admin')}
          role="link"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate('/admin');
          }}
        >
          <Icon name="ic-logo" width={30} height={28} />
          <span className="word">
            Accu<b>mu</b>
          </span>
          <span className="adminbadge">관리자</span>
        </div>

        <div className="menu">
          {MENU.map((m) => (
            <NavLink key={m.to} to={m.to} end={m.end} className={navClass}>
              <Icon name={m.icon} size={18} />
              {m.label}
            </NavLink>
          ))}
        </div>

        <div className="spacer" />

        {/* 학생 셸과 같은 .bell 버튼·같은 위치. 두 화면이 다른 시각 언어를 갖지 않게 한다. */}
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
          {unread > 0 && <span className="ndot">{unread > 9 ? '9+' : unread}</span>}
        </button>

        {/* [아바타 = 마이페이지 진입점] 학생 셸과 같은 지름길(StudentShell.jsx) — 상단 메뉴에 이미
            있는 목적지로 가는 버튼일 뿐 새 기능이 아니다. */}
        <button
          type="button"
          className="me"
          onClick={() => navigate('/admin/mypage')}
          aria-label="마이페이지"
          title="마이페이지"
        >
          <div className="adminname">
            {profile?.name}
            <em>{profile?.code}</em>
          </div>
          <div className="av" aria-hidden="true">{initial}</div>
        </button>

        <button type="button" className="bell logoutbtn" onClick={signOut} aria-label="로그아웃" title="로그아웃">
          <Icon name="ic-logout" size={20} />
        </button>
      </nav>

      <div className="wrap">{children}</div>

      <nav className="bottomnav">
        {MENU.map((m) => (
          <NavLink key={m.to} to={m.to} end={m.end} className={navClass}>
            <Icon name={m.icon} size={22} />
            <span>{m.short ?? m.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* [NotifPopup 을 학생 것과 공유한다] 알림 조회에 역할 분기가 없다 — 누구의 알림인지는
          RLS(recipient_id = auth.uid())가 정한다. 관리자용 사본을 만들면 두 화면이 시간이 지나며 어긋난다. */}
      {popup === 'calendar' && (
        <AdminCalendarPopup adminId={profile?.id} onClose={() => setPopup(null)} />
      )}
      {popup === 'notif' && (
        <NotifPopup onClose={() => setPopup(null)} onReadChange={refreshUnread} />
      )}
    </>
  );
}
