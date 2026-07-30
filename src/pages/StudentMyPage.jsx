// Accumu v2 — 마이페이지 (placeholder — 확정 B)
// 포인트 전환/지역화폐, 관심 계열 선택 UI, QR 확인은 별도 스펙. 프로토타입 screen-mypage(630~666줄) 참고.
//
// [로그아웃] 기존 StudentHomePage 골격의 유일한 기능이던 로그아웃 경로를 여기로 옮겨 유지한다.
//   홈이 실제 화면으로 바뀌면서 갈 곳이 없어졌는데, 케빈이 학생/관리자 계정을 오가며 시연하려면
//   반드시 필요한 경로다. 프로토타입 나브에는 로그아웃이 없고 스펙 A의 나브 구성에도 없으므로
//   (아바타는 "정적" 이니셜로 명시됨) 계정 정보를 다루는 마이페이지에 둔다.
//
// [확정 F-1] QR 진입점만 이 placeholder 안에 심는다. 마이페이지 본 화면(포인트 카드/전환/계열 선택)은
//   여전히 별도 스펙이다. 버튼 위치·카피·색(indigo)은 프로토타입 652줄 그대로.
//   신청 직후에는 QR을 발급하지 않는다 — 토큰이 30분 만료라 신청 시 발급하면 현장에서 반드시 만료돼 있다.
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import PlaceholderScreen from '../components/student/PlaceholderScreen';
import QrCenterModal from '../components/student/QrCenterModal';
import Icon from '../components/Icon';
import '../styles/Qr.css';

export default function StudentMyPage() {
  const { profile, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  async function handleSignOut() {
    if (busy) return;
    setBusy(true);
    try {
      await signOut();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PlaceholderScreen eyebrow="My page" title="마이페이지" sub="나의 정보와 모은 포인트를 확인하세요">
        <div className="ph-meta">
          {profile?.name} · 학번 {profile?.code}
        </div>

        <div className="ph-qr">
          <button type="button" className="qrcheck" onClick={() => setQrOpen(true)}>
            <Icon name="ic-qr" size={18} />
            QR 확인 · 입퇴장 인증
          </button>
        </div>

        <button type="button" className="ph-logout" onClick={handleSignOut} disabled={busy}>
          {busy ? '로그아웃 중…' : '로그아웃'}
        </button>
      </PlaceholderScreen>

      {qrOpen && <QrCenterModal onClose={() => setQrOpen(false)} />}
    </>
  );
}
