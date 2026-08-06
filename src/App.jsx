import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './routes/ProtectedRoute';
import RootRedirect from './routes/RootRedirect';
import StudentLayout from './routes/StudentLayout';
import AdminLayout from './routes/AdminLayout';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import NaverCallbackPage from './pages/NaverCallbackPage';
import GoogleCallbackPage from './pages/GoogleCallbackPage';
import StudentHomePage from './pages/StudentHomePage';
import StudentProgramsPage from './pages/StudentProgramsPage';
import StudentArchivePage from './pages/StudentArchivePage';
import StudentMyPage from './pages/StudentMyPage';
import AdminHomePage from './pages/AdminHomePage';
import AdminProgramsPage from './pages/AdminProgramsPage';
import AdminMyPage from './pages/AdminMyPage';
import AdminStudentArchivePage from './pages/AdminStudentArchivePage';

// 카메라 스캔 라이브러리(html5-qrcode)가 무거워 학생 번들에 섞이지 않도록 이 라우트만 분할한다.
// 학생은 QR을 "표시"만 하므로(qrcode.react) 스캐너 코드를 받을 이유가 없다.
const AdminScanPage = lazy(() => import('./pages/AdminScanPage'));

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/login" element={<LoginPage />} />
          {/* 공개 라우트 — 가입은 로그인 이전 단계다. 화면 자체가 role 을 정하지 않으므로
              ProtectedRoute 로 감싸지 않는다(승인은 DB 트리거가 한다 — ADR 0008 결정 2). */}
          <Route path="/signup" element={<SignupPage />} />
          {/* 네이버 로그인 콜백 (ADR 0009) — 네이버 개발자센터에 등록하는 Callback URL 이 이 주소다.
              구글·카카오와 달리 Supabase 콜백을 거치지 않고 앱으로 직접 돌아온다. */}
          <Route path="/auth/naver" element={<NaverCallbackPage />} />
          {/* 구글 로그인 콜백 (ADR 0011) — 네이버와 같은 형태다. Supabase 콜백이 아니라 앱으로
              직접 돌아오므로, Google Cloud Console 의 승인된 리디렉션 URI 가 곧 이 주소다. */}
          <Route path="/auth/google" element={<GoogleCallbackPage />} />

          {/* 학생 화면 — ProtectedRoute(role="student") 안쪽에서만 공통 셸이 렌더된다.
              /student/* 전체가 한 번의 role 검사를 공유하므로 권한 경계는 그대로다. */}
          <Route
            path="/student"
            element={
              <ProtectedRoute role="student">
                <StudentLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<StudentHomePage />} />
            {/* 확정 B: 홈의 네비/CTA/카드 목적지 — 대상 화면은 아직 placeholder */}
            <Route path="programs" element={<StudentProgramsPage />} />
            <Route path="archive" element={<StudentArchivePage />} />
            <Route path="mypage" element={<StudentMyPage />} />
          </Route>

          {/* 관리자 화면 — ProtectedRoute(role="admin") 안쪽에서만 관리자 셸이 렌더된다.
              /admin/* 전체가 한 번의 role 검사를 공유한다 (학생 라우트와 같은 구조).
              프로그램 관리는 실제 화면(AdminProgramsPage), 담당 학생은 아직 placeholder 다(빈 링크 아님). */}
          <Route
            path="/admin"
            element={
              <ProtectedRoute role="admin">
                <AdminLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<AdminHomePage />} />
            <Route
              path="scan"
              element={
                <Suspense fallback={<div className="route-loading">스캔 화면을 불러오는 중…</div>}>
                  <AdminScanPage />
                </Suspense>
              }
            />
            <Route path="programs" element={<AdminProgramsPage />} />
            {/* 관리자 마이페이지 = 계정 정보 + 담당 학생 아카이브(admin-students 결정 M).
                상세를 하위 경로에 두는 이유: 셸 메뉴의 활성 판정이 하위 경로까지 포함하므로 학생 아카이브를
                보는 동안에도 "마이페이지"가 켜져 있다. 형제 경로로 쪼개면 상세에서 활성 메뉴가 사라진다.
                [/admin/students 리다이렉트를 만들지 않는다] 데모에 북마크·외부 링크 개념이 없어
                죽은 경로를 유지하는 비용이 이득보다 크다. */}
            <Route path="mypage" element={<AdminMyPage />} />
            <Route path="mypage/students/:studentId" element={<AdminStudentArchivePage />} />
          </Route>
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
