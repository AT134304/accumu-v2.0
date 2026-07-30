import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/tokens.css';
// 인쇄(=PDF) 전역 규칙. 화면 스타일이 전부 로드된 뒤 마지막에 와야 @media print 의 우선순위가 안정적이다
// (아카이브 PDF 내보내기 — docs/specs/admin-students.md G절). 전역 1개를 학생·관리자가 공유한다.
import './styles/print.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
