// Accumu v2 — 참여 신청 팝업 (Accumu_prototype.html openJoin() 953~975줄 구조 그대로)
// docs/specs/student-programs.md B절 / ADR 0004 구현 가이드 3번.
//
// 구조: .mthumb(카테고리 그라데이션 + 아이콘 + 닫기) / .mbody(태그·제목·주최+상태 배지·설명·infogrid·CTA)
//
// [프로토타입과 다른 점]
//  - 확정 F-1: 카피에서 QR 언급 제거. `참석하기 · QR 발급받기` -> `참석 신청하기`,
//    `이미 신청했습니다 · 마이페이지에서 QR 확인` -> `이미 신청했습니다`. (QR은 다음 스펙이라
//    지금 QR을 약속하는 카피를 쓰면 없는 기능을 약속하는 셈이 된다.)
//  - 확정 H-1: 지난 날짜(`date < 오늘`) 프로그램은 신청 불가. 프로토타입 openJoin은 status만 봐서
//    과거 프로그램도 status='open'이면 버튼이 활성인 버그가 있다 — 재현하지 않는다.
import { useState } from 'react';
import Modal from '../Modal';
import Icon from '../Icon';
import { STATUS, catOf, statusOf } from '../../lib/taxonomy';
import { fmtDate, todayISO } from '../../lib/date';

/**
 * @param {object}   program   프로그램 행 (description 포함)
 * @param {boolean}  joined    이미 신청한 프로그램인가 (participations 행의 존재 여부로만 판정)
 * @param {boolean}  full      이번 세션에서 정원 마감으로 거부당했는가 (ADR 0006 — 조회로는 알 수 없다)
 * @param {Function} onClose   팝업 닫기
 * @param {Function} onApply   async (program) => 'created' | 'duplicate' | 'full'. 실패 시 throw.
 */
export default function JoinModal({ program, joined, full = false, onClose, onApply }) {
  const c = catOf(program.category);
  const st = statusOf(program.status);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  // todayISO()는 로컬(KST) 기준. toISOString()은 KST 오전 9시 이전에 하루 밀린다 (ADR 0003 6번).
  const isPast = program.date < todayISO();

  // CTA 상태 5종 (스펙 B절 표 + ADR 0006). 우선순위: 신청됨 > 지난 날짜 > 정원 마감 > status > 신청 가능.
  //   - joined를 맨 앞에 두는 이유: 이미 신청한 활동에는 마감/종료 사유보다 "내가 신청했다"가 더 정확한 정보다.
  //     (그리고 결정 5-2 — 이미 자리를 가진 사람에게 "마감"은 거짓말이다. 'duplicate'는 마감으로 표시하지 않는다.)
  //   - isPast를 status보다 앞에 두는 이유: 끝난 활동에 "참석 중 — 신청할 수 없습니다"는 어색하다.
  // [버튼 비활성 규칙은 프런트가 소유한다] DB with check는 date/status를 검사하지 않는다
  //   (권한 경계는 DB, 신청 가능 여부는 프런트 — ADR 0004). 정원만은 예외로 DB가 사후에 알려준다.
  let label = '참석 신청하기';
  let disabled = false;
  if (joined) {
    label = '이미 신청했습니다';
    disabled = true;
  } else if (isPast) {
    label = '이미 종료된 활동입니다';
    disabled = true;
  } else if (full) {
    // 사유 문구("정원이 모두 찼습니다")는 아래 .join-full 한 줄이 소유한다. 버튼은 status='full' 로
    // 마감된 경우와 같은 형태를 쓴다 — 학생 입장에서 결과(닫힌 버튼)가 같아야 화면이 일관된다.
    label = `${STATUS.full.label} — 신청할 수 없습니다`;
    disabled = true;
  } else if (!st.join) {
    label = `${st.label} — 신청할 수 없습니다`;
    disabled = true;
  }

  async function handleApply() {
    if (disabled || pending) return;
    setPending(true);
    setFailed(false);
    try {
      const result = await onApply(program);
      // 성공(created)/중복(duplicate) 처리와 팝업 닫기는 호출부(페이지)가 한다.
      // 정원 마감('full')은 팝업이 열린 채로 남으므로 여기서 대기 상태를 직접 푼다
      //   (그 사이 부모가 full=true 로 갱신해 버튼이 '정원이 모두 찼습니다'로 잠긴다).
      if (result === 'full') setPending(false);
    } catch {
      // 조용히 넘어가지 않는다 (스펙 기능 요구사항). 팝업을 열어둔 채 사유를 보여주고 재시도할 수 있게 한다.
      // 원본 에러 콘솔 로그는 호출부에서 남긴다.
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="join-title">
      <div className="mthumb" style={{ background: `linear-gradient(135deg,${c.soft},#fff)` }}>
        <Icon name={c.icon} size={46} color={c.color} />
      </div>

      <div className="mbody join-modal">
        {/* group(교내/교외)이 사라져 유형 이름 하나다 — ADR 0014 */}
        <span className="mtag">{c.name}</span>
        <h3 id="join-title">{program.title}</h3>
        <div className="statusline">
          주최 <b>{program.org}</b>
          {/* STATUS[].cls 첫 사용 — b-ok/b-ing/b-wait/b-close/b-over */}
          <span className={`badge ${st.cls}`}>{st.label}</span>
        </div>
        <p className="desc">{program.description}</p>

        <div className="infogrid">
          <div className="it">
            <div className="k">
              <Icon name="ic-calendar" size={14} /> 날짜
            </div>
            <div className="v">{fmtDate(program.date)}</div>
          </div>
          <div className="it">
            <div className="k">
              <Icon name="ic-clock" size={14} /> 시간
            </div>
            {/* time은 자유 텍스트라 파싱 없이 그대로 출력 */}
            <div className="v">{program.time}</div>
          </div>
          {/* 포인트 amber는 이 1칸에서만 (절대 원칙 4 — 큰 포인트 배너 금지).
              [원칙 3] "지급 예정"이다 — 신청만으로는 1P도 지급되지 않고, 지급 시점은 QR 퇴장 인증이다.
              "지역화폐 전환 가능"은 안내 문구일 뿐 전환 동작이 아니다(전환은 마이페이지 시뮬레이션 몫). */}
          <div className="it wide">
            <div className="k">
              <Icon name="ic-coin" size={14} color="var(--amber)" /> 참여 시 지급 예정 포인트
            </div>
            <div className="v pt">
              +{program.points} P <span className="sub">· 지역화폐 전환 가능</span>
            </div>
          </div>
        </div>

        <button type="button" className="mbtn" disabled={disabled || pending} onClick={handleApply}>
          {pending ? '신청 중…' : label}
        </button>
        {/* 정원 마감 사유 (ADR 0006 결정 6-4). 문구는 이 한 줄로 고정한다 —
            숫자를 붙이지 않는다("남은 자리 N석"/"N/20명"/"마감 임박" 금지. 서버가 숫자를 주지도 않는다).
            실패(권한/네트워크)와 다른 색·다른 문구여야 학생이 "내 잘못이 아니다"를 알 수 있다. */}
        {full && !joined && (
          <div className="join-full" role="status">
            정원이 모두 찼습니다
          </div>
        )}
        {failed && (
          <div className="join-err" role="alert">
            신청에 실패했어요. 잠시 후 다시 시도해 주세요.
          </div>
        )}
      </div>
    </Modal>
  );
}
