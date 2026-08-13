// Accumu v2 — 최상위 에러 바운더리 (완성도 개선)
//
// [클래스 컴포넌트인 이유] React는 함수 컴포넌트용 에러 바운더리 훅을 제공하지 않는다
//   (getDerivedStateFromError/componentDidCatch는 클래스 전용 API다). 트리 어딘가의 렌더 오류로
//   앱 전체가 흰 화면이 되는 걸 막는 마지막 방어선이라 App.jsx 최상단을 감싼다.
// [새로고침만 제공한다] 원인을 알 수 없는 렌더 오류는 상태를 부분적으로 되살리려는 시도보다
//   페이지를 통째로 다시 마운트하는 편이 안전하다 — 그래서 복구 로직 없이 새로고침 버튼 하나만 둔다.
import { Component } from 'react';
import '../styles/LoginPage.css';

export default class ErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] 처리되지 않은 렌더 오류:', error, info?.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div id="login">
        <div className="lcard" style={{ textAlign: 'center' }}>
          <div className="top">
            <h1 style={{ fontSize: 26 }}>문제가 발생했어요</h1>
            <div className="tag">화면을 표시하는 중 오류가 났어요. 새로고침해 주세요.</div>
          </div>
          <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
            새로고침
          </button>
        </div>
      </div>
    );
  }
}
