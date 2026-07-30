// Accumu v2 — 관리자 라우트 레이아웃
// 관리자 공통 셸을 한 번만 마운트하고 자식 라우트를 그 안에 렌더한다 (StudentLayout 과 같은 구조).
//
// [권한 경계] 이 레이아웃은 App.jsx 의 <ProtectedRoute role="admin"> 안쪽에서만 렌더된다.
//   /admin/* 전체가 한 번의 role 검사를 공유한다.
import { Outlet } from 'react-router-dom';
import AdminShell from '../components/admin/AdminShell';

export default function AdminLayout() {
  return (
    <AdminShell>
      <Outlet />
    </AdminShell>
  );
}
