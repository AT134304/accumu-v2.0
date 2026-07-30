// Accumu v2 — 인쇄 전용 문서 머리글
//
// [공유 컴포넌트] 학생은 "Accumu 디지털 활동 포트폴리오", 관리자는 "Accumu 활동 아카이브"로 제목만 다르다
//   (docs/specs/student-archive-mypage.md B절 대조표 — "문자열만 다름"). 컴포넌트를 복제하지 않는다.
//
// 화면에서는 Archive.css 가 display:none, 인쇄에서만 print.css 가 되살린다.
// [개인정보] 학번 이상의 식별정보를 넣지 않는다 — 애초에 DB(profiles)에 없다.
import { todayISO } from '../../lib/date';
import '../../styles/Archive.css';

/**
 * @param {{title: string, name?: string, code?: string, note?: string}} props
 */
export default function ArchivePrintHeader({
  title,
  name,
  code,
  note = 'QR 입·퇴장 인증이 완료된 활동만 기록됩니다',
}) {
  const who = [name, code].filter(Boolean).join(' · ');
  return (
    <div className="arc-printhead">
      <h2>{title}</h2>
      <div className="who">{who}</div>
      <div className="meta">
        <span>출력일 {todayISO()}</span>
        <span>{note}</span>
      </div>
    </div>
  );
}
