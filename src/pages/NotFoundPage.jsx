// Accumu v2 — 존재하지 않는 경로 (완성도 개선)
//
// [로그인 화면 껍데기 재사용] #login/.lcard/.btn-primary는 로그인·가입 화면이 이미 공유하는 중앙
//   카드 레이아웃이다. 이 화면도 셸(StudentShell/AdminShell) 밖의 최상위 라우트라 같은 틀을 쓴다
//   (LoginPage.css 자체 주석: "화면을 복제하지 않는다").
// ["/"로만 보낸다] role별 주소를 여기서 계산하지 않는다 — RootRedirect가 세션/role을 이미 판정해
//   보내주므로, 로그인 상태든 아니든 "홈으로"는 항상 맞는 곳으로 간다.
import { Link } from 'react-router-dom';
import '../styles/LoginPage.css';

export default function NotFoundPage() {
  return (
    <div id="login">
      <div className="lcard" style={{ textAlign: 'center' }}>
        <div className="top">
          <h1 style={{ fontSize: 40 }}>404</h1>
          <div className="tag">이 페이지를 찾을 수 없어요.</div>
        </div>
        <Link className="btn-primary" to="/" style={{ textDecoration: 'none' }}>
          홈으로 돌아가기
        </Link>
      </div>
    </div>
  );
}
