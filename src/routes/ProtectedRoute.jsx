// ADR 0001 "7. ProtectedRoute 동작"
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function ProtectedRoute({ role, children }) {
  const { session, profile, loading } = useAuth();

  if (loading) {
    // 판단 보류 — 리다이렉트하지 않는다.
    return <div className="route-loading">불러오는 중…</div>;
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (!profile || profile.role !== role) {
    // 에러 노출 없이 자신의 role 홈으로 조용히 리다이렉트 (스펙 요구사항)
    return <Navigate to={profile ? `/${profile.role}` : '/login'} replace />;
  }

  return children;
}
