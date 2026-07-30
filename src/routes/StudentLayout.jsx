// Accumu v2 — 학생 라우트 레이아웃
// 학생 공통 셸을 한 번만 마운트하고 자식 라우트를 그 안에 렌더한다.
// (셸이 라우트 전환마다 다시 마운트되지 않아 나브 상태/스크롤이 튀지 않는다.)
import { Outlet } from 'react-router-dom';
import StudentShell from '../components/student/StudentShell';

export default function StudentLayout() {
  return (
    <StudentShell>
      <Outlet />
    </StudentShell>
  );
}
