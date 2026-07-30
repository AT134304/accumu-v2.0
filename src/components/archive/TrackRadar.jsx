// Accumu v2 — 진로 계열별 참여 현황 (레이더 / 확정 M-2)
//
// [확정이 뒤집힌 자리다] 스펙 초안의 M-1은 "레이더 기각"이었고 케빈이 M-2(추가)로 확정했다.
//   기각 근거 3개를 그대로 두고 그린 게 아니라, 각각에 대응해 형태를 바꿨다:
//   1. "데모 2~5건이면 빈 도형" -> **축 5개를 항상 전부 그린다.** 0인 계열도 축·라벨·꼭짓점이 남아
//      "무엇을 아직 안 했는가"가 읽힌다. 텍스트 요약(ArchiveSummary)도 그대로 살려둬서
//      **그래프가 유일한 정보원이 되지 않는다**(인쇄·스크린리더·600px 이하에서도 정보가 남는다).
//   2. "게이지가 된다" -> **건수만 그린다.** 퍼센트·달성률·레벨·"N/5"·목표선·평균선이 없다.
//   3. "주력 분야 IT 5회" 라벨 -> **없앴다.** 축을 값 크기순으로 정렬하지 않으므로 순위가 생기지 않는다.
//
// [의존성 0개] recharts/chart.js/d3 를 넣지 않는다. 5축 폴리곤은 삼각함수 몇 줄이고,
//   차트 라이브러리는 (a) 범례·툴팁·애니메이션 같은 "게이지스러운" 기본값을 끌고 오며
//   (b) 인쇄에서 canvas 로 떨어지면 PDF 에서 래스터가 된다(print.css 의 벡터 원칙과 충돌).
//
// [단일 시리즈] 하나의 프로필 도형이지 5개 시리즈가 아니다. 그래서
//   - **범례를 만들지 않는다** (제목이 시리즈 이름을 대신한다)
//   - 면/선은 brand blue 하나. TRACK[].color 로 축마다 다르게 칠하지 않는다
//   - 글자는 전부 ink/muted 토큰. 시리즈 색으로 글자를 칠하지 않는다
//   - amber 금지(포인트 전용), 초록 금지(CLAUDE.md 8장)
//
// [애니메이션 없음 — 인쇄 필수] print.css 가 `*{animation:none!important}` 라서
//   등장 애니메이션에 의존해 그리면 **인쇄에서 통째로 사라진다.** 이 그래프는 포트폴리오 문서의
//   핵심 시각 요소라 인쇄에 남아야 한다. 그래서 처음부터 정적 SVG 다(StackViz 와 반대 판단).
import { summarizeByTrack } from '../../lib/archiveService';
import '../../styles/Archive.css';

/* ---------- 기하 상수 ----------
   viewBox 고정 + width:100% 라 반응형은 "축소"로 해결된다. 라벨 위치가 폭에 따라 재계산되지 않으므로
   980/768/600/430 어디서도 라벨이 서로 겹치지 않는다(비율이 그대로다). display:none 으로 숨기지 않는다. */
const N = 5;
const VB_W = 400;
const VB_H = 244;
const CX = 200;
const CY = 132;
const R = 88;

/** 눈금 링 최대 개수. 이 값 때문에 step 이 정수로 올림되어 "0.5건" 같은 눈금이 나올 수 없다. */
const MAX_RINGS = 4;

/** 0건 축의 꼭짓점 반지름(px). 0을 원점에 몰면 마커 5개가 한 점에 겹치고 도형이 면적을 잃는다.
    라벨에 실제 건수(0건)가 그대로 적히므로 이 오프셋이 값을 왜곡해 읽히지 않는다.
    (2*10*sin36° ≈ 11.8px 라 인접 0 마커끼리도 붙지 않는다) */
const ZERO_R = 10;

const angleOf = (i) => ((-90 + (i * 360) / N) * Math.PI) / 180;
const pointAt = (i, r) => [CX + r * Math.cos(angleOf(i)), CY + r * Math.sin(angleOf(i))];
const fmt = (n) => Number(n.toFixed(1));

/** 축 라벨 배치 — 5축 각도가 -90/-18/54/126/198°로 고정이라 표로 못박는다(계산보다 읽기 쉽다). */
const LABEL = [
  { anchor: 'middle', dx: 0, dy: -26 }, // 위: 두 줄이 위로 쌓인다(도형 꼭대기 y=44와 18px 간격)
  { anchor: 'start', dx: 9, dy: -2 }, // 우상
  { anchor: 'start', dx: 9, dy: 8 }, // 우하
  { anchor: 'end', dx: -9, dy: 8 }, // 좌하
  { anchor: 'end', dx: -9, dy: -2 }, // 좌상
];
const LABEL_R = R + 6;
const COUNT_DY = 14;

/**
 * 눈금 스케일. **항상 정수 눈금**이다.
 * max=1 -> step 1, 링 1 / max=3 -> step 1, 링 3 / max=5 -> step 2, 링 3(top 6) / max=7 -> step 2, 링 4(top 8)
 */
function scaleOf(max) {
  const step = Math.max(1, Math.ceil(max / MAX_RINGS));
  const rings = Math.max(1, Math.ceil(max / step));
  return { step, rings, top: step * rings };
}

/**
 * @param {{activities: Array<object>, title?: string, sub?: string}} props
 *        activities — 완료 활동(프로그램 결합본). **누구의 기록인지 알지 못한다** —
 *        관리자 담당 학생 아카이브가 그대로 재사용한다(archiveService.js 공유 규율).
 */
export default function TrackRadar({
  activities = [],
  title = '진로 계열별 참여 현황',
  sub = '완료한 활동을 진로 계열로 나눈 건수입니다',
}) {
  const { axes, plotted, unknown, max } = summarizeByTrack(activities);

  // [경계 — 그릴 값이 하나도 없으면 아예 그리지 않는다]
  //   완료 0건, 또는 완료 건이 전부 "계열을 알 수 없는" 건일 때. 모든 축이 0인 납작한 도형은
  //   정보가 아니라 실패한 화면으로 읽힌다. 이때는 아래 활동 목록의 빈 상태가 그대로 화면을 설명한다.
  if (plotted === 0) return null;

  const { step, rings, top } = scaleOf(max);
  // 0을 ZERO_R 로 밀어낸 만큼 눈금 링도 같은 식으로 매핑해야 "꼭짓점이 링 위 = 정확히 그 건수"가 성립한다.
  const radiusOf = (v) => (v <= 0 ? ZERO_R : ZERO_R + ((R - ZERO_R) * v) / top);

  const polygon = (r) =>
    axes.map((_, i) => pointAt(i, r).map(fmt).join(',')).join(' ');
  const shape = axes
    .map((a, i) => pointAt(i, radiusOf(a.count)).map(fmt).join(','))
    .join(' ');

  // 색만으로 정보를 전달하지 않는다 — 축 라벨(화면 텍스트)과 별개로 도형 전체를 한 문장으로도 읽어준다.
  const a11y = `${title}. ${axes.map((a) => `${a.label} ${a.count}건`).join(', ')}`;

  return (
    <div className="arc-panel arc-radar">
      <div className="ph">
        <h3>{title}</h3>
        <span className="phnote">{sub}</span>
      </div>

      <div className="arc-radarbox">
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label={a11y}>
          {/* 거미줄 — recessive. 값이 아니라 배경이다 */}
          {Array.from({ length: rings }, (_, g) => (
            <polygon key={g} className="grid" points={polygon(radiusOf((g + 1) * step))} />
          ))}
          {/* 0 기준선. 0건 꼭짓점이 이 원 위에 놓인다는 것을 눈으로 보여준다 */}
          <circle className="zeroring" cx={CX} cy={CY} r={ZERO_R} />

          {/* 축선 */}
          {axes.map((a, i) => {
            const [x, y] = pointAt(i, R);
            return <line key={a.key} className="spoke" x1={CX} y1={CY} x2={fmt(x)} y2={fmt(y)} />;
          })}

          {/* 프로필 도형 — 시리즈 1개. 면 채움을 항상 유지한다.
              완료 1건이면 한 축만 뻗은 뾰족한 모양이 되는데, 나머지 4개 꼭짓점이 ZERO_R 위에 있어
              밑변이 생기므로 선 두 개로 무너지지 않는다. */}
          <polygon className="shape" points={shape} />

          {/* 꼭짓점 마커 — 1건인 축도 반드시 보인다(지름 10px). 0건은 속 빈 점으로 톤을 낮춘다 */}
          {axes.map((a, i) => {
            const [x, y] = pointAt(i, radiusOf(a.count));
            const zero = a.count === 0;
            return (
              <circle
                key={a.key}
                className={zero ? 'dot zero' : 'dot'}
                cx={fmt(x)}
                cy={fmt(y)}
                r={zero ? 4 : 5}
              />
            );
          })}

          {/* 눈금 숫자 — 정수만. 도형 위에 그리되 흰 테두리(paint-order)로 읽히게 한다 */}
          {Array.from({ length: rings }, (_, g) => {
            const v = (g + 1) * step;
            return (
              <text key={v} className="tick" x={CX + 5} y={fmt(CY - radiusOf(v) + 3)}>
                {v}
              </text>
            );
          })}

          {/* 축 라벨 = 계열명 + 건수 (접근성: 색이 아니라 글자가 정보를 전달한다) */}
          {axes.map((a, i) => {
            const [bx, by] = pointAt(i, LABEL_R);
            const { anchor, dx, dy } = LABEL[i];
            const x = fmt(bx + dx);
            const y = fmt(by + dy);
            return (
              <g key={a.key}>
                <text className="ax-name" x={x} y={y} textAnchor={anchor}>
                  {a.label}
                </text>
                <text
                  className={a.count === 0 ? 'ax-val zero' : 'ax-val'}
                  x={x}
                  y={y + COUNT_DY}
                  textAnchor={anchor}
                >
                  {a.count}건
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* 게시중단으로 계열을 알 수 없는 건 — 조용히 빼면 그래프 합계와 요약 총합이 어긋난다.
          어느 축에도 얹지 않았다는 사실을 그대로 적는다(ADR 0005 결정 7-4). */}
      {unknown > 0 && (
        <p className="arc-radarnote">
          분류를 확인할 수 없는 활동 <b>{unknown}건</b>은 그래프에서 제외했습니다.
        </p>
      )}
    </div>
  );
}
