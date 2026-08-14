// Accumu v2 — 참여 신청 팝업 (Accumu_prototype.html openJoin() 953~975줄 구조 그대로)
// docs/specs/student-programs.md B절 / ADR 0004 구현 가이드 3번 / ADR 0016(취소·대기열·신청자 수).
//
// 구조: .mthumb(카테고리 그라데이션 + 아이콘 + 닫기) / .mbody(태그·제목·주최+상태 배지·설명·infogrid·CTA)
//
// [프로토타입과 다른 점]
//  - 확정 F-1: CTA 라벨(`mbtn`)에서는 여전히 QR을 언급하지 않는다. `참석하기 · QR 발급받기` ->
//    `참석 신청하기`, `이미 신청했습니다 · 마이페이지에서 QR 확인` -> `이미 신청했습니다`.
//    [2026-08-11 부분 해제] 이 결정의 원래 이유("QR 기능 자체가 없어서 약속하면 거짓")는 QR이
//    실제로 구현된 지금은 유효하지 않다. 그래서 infogrid 아래 안내문(join-period-note)에는 QR을
//    언급한다 — 신청 후 뭘 해야 하는지 몰라 참여를 놓치는 학생이 생기는 게 더 큰 문제라서다.
//    CTA 버튼 라벨만은 그대로 QR을 안 담는다(버튼은 "지금 이 클릭이 뭘 하는가"만 말하는 자리라
//    안내문과 섞으면 라벨이 길어져 오히려 읽기 어렵다 — 순수 레이아웃상의 이유로 유지).
//  - 확정 H-1: 지난 날짜(`date < 오늘`) 프로그램은 신청 불가. 프로토타입 openJoin은 status만 봐서
//    과거 프로그램도 status='open'이면 버튼이 활성인 버그가 있다 — 재현하지 않는다.
//  - ADR 0016: 정원이 차도 신청을 거부하지 않는다 — 'waitlisted'로 등록된다. 그래서 예전의 '마감'
//    분기(버튼 비활성)가 사라지고 "신청하면 대기로 등록된다"는 사전 안내로 바뀌었다.
import { useState } from 'react';
import Modal from '../Modal';
import Icon from '../Icon';
import { useTutorial } from '../../context/TutorialContext';
import { catOf, statusOf, TRACK } from '../../lib/taxonomy';
import { fmtDateRange, todayISO } from '../../lib/date';

/**
 * @param {object}   program         프로그램 행 (description 포함)
 * @param {{id: string, status: string}|undefined} participation
 *   본인의 참여 행(있으면). status는 applied/waitlisted/entered/completed 중 하나.
 *   존재 자체가 "신청됨"의 증거다(ADR 0004 구현 가이드 4번) — 값이 없으면 신청 이력이 없다는 뜻.
 * @param {number}   applicantCount  이 프로그램에 자리를 확보한 인원(applied+entered+completed).
 *   케빈 요청(2026-08-10) "신청자 수를 보이게 해" — program_applicant_counts() RPC (ADR 0016).
 * @param {number|null} waitlistPosition 내가 대기 중이면 몇 번째인지(1부터). ADR 0018 —
 *   my_waitlist_positions() RPC. 대기 중이 아니면 null.
 * @param {string|null} adminName 이 프로그램을 올린 관리자 이름 (ADR 0023 — program_admin_names() RPC).
 *   null 이면 그 칸을 렌더하지 않는다. "-" 나 "미정" 으로 채우지 말 것 — created_by 가 없는 행과
 *   조회 실패를 구분할 수 없는데, 둘 다 "담당자가 없다"는 사실이 아니다.
 * @param {Function} onClose         팝업 닫기
 * @param {Function} onApply         async (program) => 'created' | 'waitlisted' | 'duplicate'. 실패 시 throw.
 * @param {Function} onCancel        async (participationId) => {ok:true,promoted:boolean} | {ok:false,reason}.
 *   실패(네트워크 등)만 throw — "취소 가능 시점이 지났다"는 throw가 아니라 ok:false로 온다.
 */
export default function JoinModal({
  program,
  participation,
  applicantCount = 0,
  waitlistPosition = null,
  adminName = null,
  onClose,
  onApply,
  // [기본값이 있는 이유] 홈(StudentHomePage)은 취소 경로가 없다 — 홈 추천은 이미 신청한 프로그램을
  // 애초에 제외하므로(확정 D-1) participation 이 항상 undefined 이고 canCancel 이 false 다.
  // 아래 handleCancel 의 가드가 이미 막지만, "안 넘겨도 되는 prop"이라는 사실을 시그니처에 적어둔다.
  onCancel = null,
}) {
  const c = catOf(program.category);
  const st = statusOf(program.status);
  // 진로 계열 (ADR 0014 — category 와 별개 축). 카드의 계열 칩과 같은 값을 팝업에서도 보여준다.
  const track = TRACK[program.career_track] ?? null;
  const tutorial = useTutorial();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cancelMsg, setCancelMsg] = useState(null);
  // 대표 사진(ADR 0022). 깨진 URL이면 아이콘으로 되돌린다 — ProgramCard와 같은 처리.
  const [photoFailed, setPhotoFailed] = useState(false);
  const photo = program.image_url && !photoFailed ? program.image_url : null;

  // todayISO()는 로컬(KST) 기준. toISOString()은 KST 오전 9시 이전에 하루 밀린다 (ADR 0003 6번).
  // [기간제] 종료일이 지나야 "끝난 활동"이다 — 시작한 뒤에도 기간 중에는 계속 신청 가능해야 한다.
  // [is_tutorial — ADR 0021] date 값 자체가 의미 없는 자리표시자다 — "지난 날짜" 판정에서 제외한다.
  const today = todayISO();
  const isPast = !program.is_tutorial && (program.end_date ?? program.date) < today;
  const isPeriod = Boolean(program.end_date);

  const status = participation?.status; // undefined | applied | waitlisted | entered | completed
  const joined = Boolean(status);
  // 정원이 찼다는 사실은 "신청하면 대기 등록된다"는 사전 안내일 뿐 버튼을 잠그지 않는다(ADR 0016) —
  // 예전 결정 5-1의 hint='capacity_full' 거부가 사라졌으니 여기서도 막을 이유가 없다.
  const capacityFull = !joined && program.capacity != null && applicantCount >= program.capacity;
  // 취소 가능 조건 — 서버 cancel_my_participation()의 진짜 경계(today_kst() < programs.date)와 같다.
  // entered/completed는 이미 시작했으므로 취소 대상이 아니다. 여기서 막아도 서버가 다시 확인한다
  //   (프런트 날짜 조작으로는 우회되지 않는다 — 이 판정은 UX일 뿐 권한 경계가 아니다).
  const canCancel = (status === 'applied' || status === 'waitlisted') && today < program.date;

  // CTA 상태 (스펙 B절 표 + ADR 0016). 우선순위: 대기중 > 신청됨(입장/퇴장 포함) > 지난 날짜 > 대기 신청 안내 > status > 신청 가능.
  let label = '참석 신청하기';
  let disabled = false;
  if (status === 'waitlisted') {
    // [대기 순번 — ADR 0018] 순번을 알면 "대기 중이에요"보다 훨씬 구체적인 기대치를 준다.
    label = waitlistPosition != null ? `대기 ${waitlistPosition}번째예요` : '대기 중이에요';
    disabled = true;
  } else if (joined) {
    label = '이미 신청했습니다';
    disabled = true;
  } else if (isPast) {
    label = '이미 종료된 활동입니다';
    disabled = true;
  } else if (capacityFull) {
    // 마감이 아니라 대기 등록으로 이어지는 신청이다 — 버튼을 잠그지 않는다.
    label = '대기 신청하기';
  } else if (!st.join) {
    label = `${st.label} — 신청할 수 없습니다`;
    disabled = true;
  }

  async function handleApply() {
    if (disabled || pending) return;
    setPending(true);
    setFailed(false);
    try {
      await onApply(program);
      // 성공(created)/대기(waitlisted)/중복(duplicate) 셋 다 페이지가 팝업을 닫는다 — 여기서 더 할 일이 없다.
    } catch {
      // 조용히 넘어가지 않는다 (스펙 기능 요구사항). 팝업을 열어둔 채 사유를 보여주고 재시도할 수 있게 한다.
      // 원본 에러 콘솔 로그는 호출부에서 남긴다.
      setFailed(true);
      setPending(false);
    }
  }

  async function handleCancel() {
    if (!canCancel || !participation || pending) return;
    setPending(true);
    setCancelMsg(null);
    try {
      const result = await onCancel(participation.id);
      if (!result.ok) {
        // 너무 늦었거나(too_late) 이미 시작한(already_started) 경우 — 새로고침·다른 탭 등으로
        // 화면과 서버 날짜가 어긋났을 때 생긴다. 팝업을 열어둔 채 사유를 보여준다.
        setCancelMsg(
          result.reason === 'too_late'
            ? '프로그램 시작 전날까지만 취소할 수 있어요'
            : '이미 시작된 참여는 취소할 수 없어요'
        );
        setPending(false);
        return;
      }
      // 성공 시 페이지가 상태를 다시 읽고 팝업을 닫는다.
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="join-title">
      {/* [썸네일 자리 — ADR 0022] 카드와 같은 규칙: 사진이 있으면 사진, 없으면 카테고리 아이콘.
          카드에서 사진을 보고 눌렀는데 팝업에서 아이콘으로 바뀌면 "다른 것을 열었나" 싶어진다 —
          두 화면이 같은 값을 쓴다(ProgramCard 와 fallback 처리까지 동일). */}
      <div className={photo ? 'mthumb has-photo' : 'mthumb'} style={{ background: `linear-gradient(135deg,${c.soft},#fff)` }}>
        {photo ? (
          <img className="thumb-photo" src={photo} alt="" onError={() => setPhotoFailed(true)} />
        ) : (
          <Icon name={c.icon} size={46} color={c.color} />
        )}
      </div>

      <div className="mbody join-modal">
        {/* group(교내/교외)이 사라져 유형 이름 하나다 — ADR 0014 */}
        <span className="mtag" style={{ background: c.deep }}>
          {c.name}
        </span>
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
            {/* [is_tutorial — ADR 0021] date 값 자체가 자리표시자라 그대로 찍지 않는다. */}
            <div className="v">{program.is_tutorial ? '상시 진행' : fmtDateRange(program.date, program.end_date)}</div>
          </div>
          <div className="it">
            <div className="k">
              <Icon name="ic-clock" size={14} /> 시간
            </div>
            {/* time은 자유 텍스트라 파싱 없이 그대로 출력 */}
            <div className="v">{program.time}</div>
          </div>
          {/* [진로 계열 — 케빈 요청 2026-08-14] 카드의 계열 칩과 같은 값. 팝업에서는 색 점 대신
              글자에 계열색을 준다 — 흰 패널 위라 대비가 확보되고(칩은 사진 위라 그럴 수 없었다),
              무엇보다 이 칸은 "값"이 주인공인 자리다. TRACK 에 없는 키면 칸을 렌더하지 않는다. */}
          {track && (
            <div className="it">
              <div className="k">
                <Icon name="ic-target" size={14} /> 진로 계열
              </div>
              <div className="v" style={{ color: track.color }}>
                {track.name}
              </div>
            </div>
          )}
          {/* [담당 관리자 — 케빈 요청 2026-08-14, ADR 0023] "주최"(org, 위 statusline)는 기관이고
              이건 사람이다 — 둘은 다른 정보라 한 줄로 합치지 않는다.
              [없으면 칸 자체를 숨긴다] created_by 가 NULL 인 행과 RPC 조회 실패를 프런트가 구분할
              수 없다. 둘 다 "담당자가 없다"는 사실이 아니므로 '-' 로 채우면 거짓말이 된다. */}
          {adminName && (
            <div className="it">
              <div className="k">
                <Icon name="ic-user" size={14} /> 담당 관리자
              </div>
              <div className="v">{adminName}</div>
            </div>
          )}
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
          {/* 신청 현황 — 케빈 요청(2026-08-10) "신청자 수를 보이게 해" (ADR 0016).
              비율/게이지가 아니라 두 숫자를 나란히 적을 뿐이다 — 정렬·경쟁 요소가 아니다(원칙 1). */}
          <div className="it wide">
            <div className="k">
              <Icon name="ic-users" size={14} /> 신청 현황
            </div>
            <div className="v">
              {applicantCount}명 신청
              {program.capacity != null && <span className="sub"> · 정원 {program.capacity}명</span>}
            </div>
          </div>
        </div>

        {/* 기간제 프로그램 안내 — 신청 후 QR 센터에서 "오늘 입장/퇴장" 흐름이 하루짜리와 다르다는 것을
            미리 말해준다. 카피에서 QR을 약속하지 않는 기존 규율(확정 F-1)과 달리 여기는 신청 여부를
            결정하는 정보라 언급이 필요하다 — "그 날짜에만 인증할 수 있다"와 "포인트를 언제 받는지"를
            모르고 신청하면 놀란다. [진행일 — 20260809180000] 범위 전체가 아니라 관리자가 고른 날짜만
            진행되므로(주말만/특정요일 등) "매일"이라 말하지 않는다 — 총 횟수만 사실대로 적는다
            (원칙 1: 분모 없는 개수). 지급 방식 3종(20260809160000)에 따라 마지막 문장만 갈린다. */}
        {isPeriod && (
          <p className="join-period-note">
            이 기간 중 <b>총 {program.session_dates?.length ?? '-'}일</b> 진행되며, 그 날짜마다 입·퇴장 QR
            인증이 필요합니다.{' '}
            {program.attendance_payout_mode === 'per_session'
              ? '포인트는 퇴장 인증을 할 때마다 매번 지급됩니다.'
              : program.attendance_payout_mode === 'threshold'
                ? `최소 ${program.min_attendance_days ?? '-'}일 이상 참여하면 그 시점에 포인트가 한 번 지급됩니다.`
                : '포인트는 종료일 퇴장 인증 때 한 번에 지급됩니다.'}
          </p>
        )}
        {/* [단일 일자 QR 안내 — ADR 0018, 2026-08-11] 확정 F-1은 "QR을 약속하는 카피 금지"였다 — 그때는 QR
            기능 자체가 없었다. 지금은 실제로 있으므로(CLAUDE.md 6장) 더 이상 거짓 약속이 아니다.
            기간제와 똑같이 "신청 후 QR로 뭘 해야 하는지"를 미리 말해준다 — 안 그러면 신청만 하고
            QR 센터를 어떻게 찾는지 몰라 참여를 놓치는 학생이 생긴다. */}
        {!isPeriod && !program.is_tutorial && (
          <p className="join-period-note">
            신청 후 <b>마이페이지 · QR 확인</b>에서 입장 QR을 인증해야 참석이 시작되고, 종료 시
            퇴장 QR을 인증해야 포인트가 지급됩니다.
          </p>
        )}
        {/* [튜토리얼 전용 안내 — ADR 0021] 일반 안내와 문구를 다르게 쓴다 — 이 프로그램은 실제 활동이
            아니라 QR 인증·아카이브·포인트가 어떻게 이어지는지 미리 보여주는 연습이라는 점, 그리고
            관리자 스캔 없이 자동으로 인증된다는 점을 신청 전에 알려준다. */}
        {program.is_tutorial && (
          <p className="join-period-note">
            신청 후 <b>마이페이지 · QR 확인</b>에서 입·퇴장 QR을 인증해 보세요. 실제 활동과 달리
            카메라 스캔 없이 QR을 보여주면 자동으로 인증됩니다 — Accumu의 QR 인증·포인트 지급·
            디지털 아카이브 기록 과정을 미리 체험해 보는 연습용 활동이에요.
          </p>
        )}

        {/* 대기/마감 안내 — "실패"가 아니라 상태다. rose(오류)와 다른 중립 톤(join-hint).
            [순번 — ADR 0018] 알 수 있을 때만 문장 맨 앞에 붙인다(조회 실패로 null이면 이전처럼
            순번 없이 안내한다 — 모르는 걸 안다고 말하지 않는다). */}
        {status === 'waitlisted' && (
          <div className="join-hint" role="status">
            {waitlistPosition != null && <>현재 대기 {waitlistPosition}번째예요. </>}
            대기 순번이 앞당겨지면 자동으로 자리가 확정돼요. 확정 전까지는 QR이 발급되지 않아요.
          </div>
        )}
        {capacityFull && !joined && (
          <div className="join-hint" role="status">
            정원이 가득 찼어요 — 지금 신청하면 대기 명단에 등록돼요
          </div>
        )}

        {/* [ADR 0021] 튜토리얼 프로그램 신청 버튼만 2단계 하이라이트 대상이 된다 — 실제 신청 성공
            여부를 다시 확인하지 않는 근사치 트래커라, 클릭 자체를 "신청했다"로 본다. */}
        <button
          type="button"
          className="mbtn"
          disabled={disabled || pending}
          onClick={handleApply}
          data-tutorial={program.is_tutorial && tutorial.isStep(2) ? 2 : undefined}
        >
          {pending ? '처리 중…' : label}
        </button>

        {/* 신청 취소 — 프로그램 시작 전날까지만(ADR 0016). 케빈 요청(2026-08-10). */}
        {canCancel && (
          <button type="button" className="join-cancel" disabled={pending} onClick={handleCancel}>
            {pending ? '처리 중…' : '신청 취소하기'}
          </button>
        )}

        {cancelMsg && (
          <div className="join-err" role="alert">
            {cancelMsg}
          </div>
        )}
        {failed && (
          <div className="join-err" role="alert">
            처리에 실패했어요. 잠시 후 다시 시도해 주세요.
          </div>
        )}
      </div>
    </Modal>
  );
}
