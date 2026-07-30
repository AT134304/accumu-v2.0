// Accumu v2 — 관리자 화면 placeholder (2단계 구현분: 프로그램 관리 / 담당 학생 아카이브 + PDF)
//
// [빈 링크가 아니라 실제 라우트다] 스펙 요구사항: "프로그램 관리 / 담당 학생 메뉴는 placeholder다(빈 링크 아님)".
//   ADR 0005 "추가 확정"이 구현을 2단계로 나눴고, 2단계는 **새 마이그레이션 0개**(정책 6개는 1단계에서 함께
//   적용됨)라 순수 frontend 작업으로 남는다. 여기에 기능을 앞당겨 만들지 말 것.
import Icon from '../components/Icon';

export default function AdminPlaceholderPage({ eyebrow, title, sub, note }) {
  return (
    <section className="screen">
      <div className="sec-head">
        <div>
          <div className="eyebrow">{eyebrow}</div>
          <h2 className="sec">{title}</h2>
          <div className="sec-sub">{sub}</div>
        </div>
      </div>

      <div className="ph-panel">
        <div className="ph-ic">
          <Icon name="ic-clock" size={22} color="var(--brand)" />
        </div>
        <h3>화면 준비 중</h3>
        <p>{note}</p>
      </div>
    </section>
  );
}
