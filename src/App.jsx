import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './routes/ProtectedRoute';
import RootRedirect from './routes/RootRedirect';
import StudentLayout from './routes/StudentLayout';
import AdminLayout from './routes/AdminLayout';
import LoginPage from './pages/LoginPage';
import StudentHomePage from './pages/StudentHomePage';
import StudentProgramsPage from './pages/StudentProgramsPage';
import StudentArchivePage from './pages/StudentArchivePage';
import StudentMyPage from './pages/StudentMyPage';
import AdminHomePage from './pages/AdminHomePage';
import AdminProgramsPage from './pages/AdminProgramsPage';
// 담당 학생 아카이브는 아직 별도 스펙 단계라 placeholder 를 유지한다(프로그램 관리 라우트만 교체됐다).
import AdminPlaceholderPage from './pages/AdminPlaceholderPage';

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
            <Route
              path="students"
              element={
                <AdminPlaceholderPage
                  eyebrow="Students"
                  title="담당 학생"
                  sub="담당 학생의 활동 아카이브를 확인합니다"
                  note="담당 학생 아카이브 조회와 PDF 확인은 다음 단계에서 구현됩니다."
                />
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
