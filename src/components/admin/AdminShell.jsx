// Accumu v2 — 관리자 공통 셸 (docs/specs/qr-dual-auth.md "C. 관리자 — 공통 셸", 확정 G-3 1단계분)
//
// 학생 셸(StudentShell)의 시각 언어를 그대로 따르되 세 가지를 **의도적으로 넣지 않는다**:
//   - 포인트 표시: 관리자에게 포인트 개념이 없다(스펙 C절).
//   - 알림/캘린더: 관리자용 이벤트 소스가 없다.
//   - 참여자 수·출석률·랭킹·학교 통계: 원칙 1·6. 애초에 관리자에게 그 데이터를 주는 RLS 정책이 없다.
//
// [로그아웃] 기존 AdminHomePage 63줄 골격의 유일한 기능이었다. 홈이 실제 화면으로 바뀌면서 갈 곳을 잃지 않도록
//   여기(셸 우측)로 옮긴다. 1인 시연에서 학생/관리자 계정을 오가는 필수 경로다.
//
// [StudentShell.css 를 함께 import 하는 이유] 그 파일은 학생 전용이 아니라 앱 공통 시각 언어
//   (.nav / .wrap / .bottomnav / .screen / .empty / .overlay / .modal)를 담고 있다. 관리자 셸도 같은 언어를 쓴다.
//   200줄을 복제하면 두 셸이 시간이 지나며 어긋난다.
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Icon from '../Icon';
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
const MENU = [
  { to: '/admin', icon: 'ic-home', label: '홈', end: true },
  { to: '/admin/scan', icon: 'ic-qr', label: 'QR 스캔' },
  { to: '/admin/programs', icon: 'ic-compass', label: '프로그램 관리' },
  { to: '/admin/mypage', icon: 'ic-user', label: '마이페이지' },
];

const navClass = ({ isActive }) => (isActive ? 'on' : undefined);

export default function AdminShell({ children }) {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();

  const initial = profile?.name?.trim()?.[0] ?? '';

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

        <div className="me">
          <div className="adminname">
            {profile?.name}
            <em>{profile?.code}</em>
          </div>
          <div className="av" aria-hidden="true">{initial}</div>
        </div>

        <button type="button" className="bell logoutbtn" onClick={signOut} aria-label="로그아웃" title="로그아웃">
          <Icon name="ic-logout" size={20} />
        </button>
      </nav>

      <div className="wrap">{children}</div>

      <nav className="bottomnav">
        {MENU.map((m) => (
          <NavLink key={m.to} to={m.to} end={m.end} className={navClass}>
            <Icon name={m.icon} size={22} />
            <span>{m.label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}
