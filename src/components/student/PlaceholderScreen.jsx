// Accumu v2 — 학생 화면 placeholder (docs/specs/student-home.md 확정 B)
// 홈의 네비/CTA/카드 클릭 목적지가 실제로 존재하도록 두는 껍데기 화면.
// eyebrow/제목/부제 카피는 프로토타입의 해당 screen 헤더(584~633줄)를 그대로 가져와,
// 각 화면의 스펙이 오면 이 자리를 본문으로 채우기만 하면 되게 한다.
import Icon from '../Icon';

export default function PlaceholderScreen({ eyebrow, title, sub, children }) {
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
        <p>이 화면은 다음 스펙에서 구현됩니다.</p>
        {children}
      </div>
    </section>
  );
}
