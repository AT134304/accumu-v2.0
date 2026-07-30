// ADR 0001 라우트 테이블 — `/`는 세션/role에 따라 즉시 리다이렉트하는 전용 경로.
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function RootRedirect() {
  const { session, profile, loading } = useAuth();

  if (loading) {
    return <div className="route-loading">불러오는 중…</div>;
  }

  if (!session || !profile) {
    return <Navigate to="/login" replace />;
  }

  return <Navigate to={`/${profile.role}`} replace />;
}
