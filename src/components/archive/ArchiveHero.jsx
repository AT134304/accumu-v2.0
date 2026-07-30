// Accumu v2 — 아카이브 히어로 (마일스톤 전용 어두운 패널)
//
// [공유 컴포넌트] 학생 아카이브 + 관리자 담당 학생 아카이브가 같이 쓴다. 누구의 기록인지 알지 못한다 —
//   completed 배열만 받는다 (docs/specs/student-archive-mypage.md B절 공유 규칙).
//
// [왜 어두운 패널인가 — admin-students 이슈 5]
//   StackViz 의 빈 블록은 rgba(255,255,255,.14) 라 흰 카드 위에서는 보이지 않는다. 학생 홈의 .hero 와
//   같은 계열의 배경 위에 놓아야 "블록이 쌓인다"는 표현이 성립한다.
//   600px 이하에서는 StackViz 가 display:none 이라 패널째 숨기고(빈 검은 상자 방지),
//   인쇄에서도 숨긴다 — 요약 블록(활동 수·유형 분포·활동 기간)이 그 역할을 텍스트로 대신한다.
//
// [원칙 1 가드] 이 패널에 숫자·레벨·게이지·"N개 달성" 라벨·범례를 붙이지 않는다.
//   StackViz.jsx 와 StudentHome.css 의 .stackviz 규칙은 홈과 공유하는 자산이라 수정하지 않는다.
import StackViz from '../student/StackViz';
import '../../styles/Archive.css';

/**
 * @param {{completed: Array<{program: object|null}>, title?: string, sub?: string}} props
 *        completed — status='completed' 인 참여 목록(프로그램 결합본). 미전달이면 빈 마일스톤이 뜬다.
 */
export default function ArchiveHero({
  completed = [],
  title = '최근 5개월 마일스톤',
  sub = '완료한 활동이 활동 월에 맞춰 쌓입니다',
}) {
  return (
    <div className="arc-hero">
      <div className="glow" />
      <div className="arc-herohead">
        <div className="eyebrow">Milestone</div>
        <h3>{title}</h3>
        <p>{sub}</p>
      </div>
      <StackViz completed={completed} />
    </div>
  );
}
