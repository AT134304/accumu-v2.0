// Accumu v2 — 학생 QR 목록/표시 모달 (docs/specs/qr-dual-auth.md A·B절, 확정 F-1)
// Accumu_prototype.html openQrList()(1003줄) + showScan()(1025줄)의 구조·카피를 재현한다.
//
// [프로토타입과 의도적으로 다른 곳 — 이게 v2의 본체다]
//   1. "5초 후 자동 처리" 카운트다운(1039줄)을 삭제했다. 스캐너가 없던 시절의 가짜 시뮬레이션이고,
//      그대로 옮기면 그 자체가 절대 원칙 5의 "단순화"다. 같은 자리에 남은 유효시간(mm:ss)을 표시한다.
//   2. 상태 전이는 학생이 만들지 않는다. 관리자가 스캔해야 서버가 전이시키고, 학생 화면은 10초 폴링으로
//      그 결과를 따라간다 (participations 에 update 정책이 학생·관리자 모두 0개 — ADR 0005 결정 2).
//   3. 프로토타입 1054줄의 축하 이모지 토스트("참여 완료! +300P 지급")를 옮기지 않았다.
//      컨페티·사운드·숫자 카운트업·축하 이모지 금지 (원칙 1). 담백한 체크 아이콘 + 문구까지만.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import Icon from '../Icon';
import Modal from '../Modal';
import ReviewForm from './ReviewForm';
import { useAuth } from '../../context/AuthContext';
import { useTutorial } from '../../context/TutorialContext';
import { catOf } from '../../lib/taxonomy';
import { fmtDateRange, isProgramOver, todayISO } from '../../lib/date';
import {
  buildQrPayload,
  fetchAttendanceSessions,
  fetchMyParticipationsWithProgram,
  fetchParticipationStatuses,
  issueAttendanceQr,
  issueQr,
  issueRejectText,
  verifyTutorialQr,
} from '../../lib/participationService';
import { dismissMyParticipation } from '../../lib/programService';
import '../../styles/Qr.css';

// [폴링 주기 — 2026-08-07 단일 10초에서 2단으로 바꿨다]
//   증상: 관리자 화면에는 인증 성공이 즉시 뜨는데 학생 화면이 "인증 완료"로 넘어가는 데 오래 걸린다.
//   원인: 10초 단일 주기라 평균 5초, 최악 10초 늦었다. 카메라 인식 속도와는 무관한 지연이다.
//   현장에서 스캔은 QR 을 띄운 직후 몇 초 안에 일어나므로, 그 구간만 2초로 좁히고 이후 10초로 되돌린다.
//   비용은 사실상 0 이다 — 이 폴링은 QR 화면이 열려 있는 동안에만 돌고(done 이면 멈춘다),
//   쿼리도 본인 행의 select id, status 뿐이다(fetchParticipationStatuses).
//   >>> Realtime 구독으로 바꾸지 말 것. 스펙(qr-dual-auth.md)이 명시적으로 배제했고, 테이블 publication
//       설정이 늘어 시연 당일 실패 지점만 는다. 2초면 체감 차이가 거의 없다.
const POLL_FAST_MS = 2_000;
const POLL_SLOW_MS = 10_000;
const POLL_FAST_WINDOW_MS = 120_000; // QR 표시(또는 재발급) 후 2분

// [ADR 0021] 튜토리얼 프로그램은 관리자 스캔을 기다리지 않고 학생 화면이 직접 검증을 부른다.
// 0초 즉시 처리하면 "QR이 뭘 하는 물건인지" 느낄 틈도 없이 화면이 넘어간다 — 실제 스캔 한 번의
// 체감 시간과 비슷하게 짧은 지연을 둔다. 판정 자체와는 무관한 순수 연출용 상수다.
const TUTORIAL_AUTO_VERIFY_MS = 1_600;

/** 참여 상태 -> 목록 보조 문구 (프로토타입 1013줄 카피). 단일 일자 프로그램 전용 —
 *  기간제는 참여 전체 상태가 아니라 "오늘" 세션 상태를 보여줘야 해서 periodActionOf()가 별도로 만든다. */
const STATUS_LABEL = { applied: '입장 대기', entered: '참석 중 (퇴장 전)' };

/**
 * 게시중단된 프로그램의 참여 건은 학생이 programs 행을 읽을 수 없다 (ADR 0005 결정 7-4 "알려진 틈").
 * program_id 만 있고 프로그램 정보가 없는 경우를 오류가 아니라 정상 경로로 다룬다.
 */
function programView(program) {
  if (program) {
    const cat = catOf(program.category);
    return {
      title: program.title,
      icon: cat.icon,
      color: cat.color,
      soft: cat.soft,
      // 기간제(program.end_date 있음)는 범위로 찍힌다 — fmtDateRange가 단일 일자면 자동으로 fmtDate와 같다.
      // [is_tutorial — ADR 0021] date 값이 자리표시자라 그대로 찍지 않는다.
      meta: [
        program.is_tutorial ? '상시 진행' : fmtDateRange(program.date, program.end_date),
        program.points ? `+${program.points}P` : null,
      ].filter(Boolean),
      points: program.points ?? null,
    };
  }
  return {
    title: '프로그램 정보를 볼 수 없는 활동',
    icon: 'ic-grid',
    color: '#64748B',
    soft: '#E9EDF3',
    meta: ['게시가 중단된 프로그램일 수 있어요'],
    points: null,
  };
}

/**
 * session_dates 중 today보다 뒤인 가장 이른 날짜. 정렬돼 있다는 보장이 없으므로(관리자 폼은 정렬해
 * 보내지만 이 함수 자체는 그 전제에 기대지 않는다) 매번 최솟값을 계산한다.
 */
function nextSessionAfter(sessionDates, today) {
  const future = (sessionDates ?? []).filter((d) => d > today);
  if (future.length === 0) return null;
  return future.reduce((min, d) => (d < min ? d : min));
}

/**
 * 기간제 프로그램(program.end_date 있음)의 "오늘" 액션을 결정한다. 단일 일자면 null을 돌려주고
 * 호출부가 기존(participation.status 기반) 분기를 그대로 쓴다.
 *
 * [원칙 1 가드] "N일차/M일 중 N일 출석" 같은 진행률 라벨을 만들지 않는다 — 오늘 할 수 있는 행동 하나만
 *   말한다. "다음 진행일이 언제인가"는 진행률이 아니라 사실 하나(날짜)라 note로 곁들인다 — 비율·잔여
 *   일수·퍼센트를 계산하지 않는다.
 *
 * @param {object} item fetchMyParticipationsWithProgram() 행 (program 포함)
 * @param {Array<{session_date:string, status:string}>} sessions fetchAttendanceSessions() 결과
 * @returns {{disabled:boolean, label:string, type:'entry'|'exit'|null, note?:string}|null}
 */
function periodActionOf(item, sessions) {
  const prog = item.program;
  if (!prog?.end_date) return null;

  const today = todayISO();
  const sessionDates = Array.isArray(prog.session_dates) ? prog.session_dates : [];
  const nextNote = (day) => {
    const next = nextSessionAfter(sessionDates, day);
    return next ? `다음 진행일 ${fmtDateRange(next)}` : null;
  };

  if (today < prog.date) {
    return { disabled: true, label: '기간 시작 전', type: null, note: nextNote(today) };
  }
  if (today > prog.end_date) {
    return { disabled: true, label: '기간이 끝났어요', type: null };
  }
  // [진행일 — 20260809180000] 범위 안이라도 관리자가 고른 진행일이 아니면(주말만/특정요일 등) 오늘은 쉬는 날이다.
  if (sessionDates.length > 0 && !sessionDates.includes(today)) {
    return { disabled: true, label: '오늘은 진행일이 아니에요', type: null, note: nextNote(today) };
  }

  const todaySession = (sessions ?? []).find((s) => s.session_date === today) ?? null;
  if (!todaySession || todaySession.status === 'applied') {
    return { disabled: false, label: '오늘 입장 QR', type: 'entry' };
  }
  if (todaySession.status === 'entered') {
    return { disabled: false, label: '오늘 퇴장 QR', type: 'exit' };
  }
  // completed — 오늘 몫은 끝났다. 다음 진행일이 있으면 그것도 사실이니 함께 보여준다.
  return { disabled: true, label: '오늘 출석 완료', type: null, note: nextNote(today) };
}

/**
 * 진행이 끝난 참여인가 — 판정 자체는 date.js 의 isProgramOver() 가 소유한다(앱 전체가 같은 식).
 *
 * [program 이 null 이면 false 다] 게시가 중단된 프로그램은 RLS 때문에 조회되지 않아 날짜를 알 수 없다.
 *   모르는 것을 "끝났다"로 단정하지 않는다 — 그 행은 지금처럼 본 목록에 "볼 수 없는 활동"으로 남는다.
 *   (isProgramOver 도 null 을 false 로 돌려주므로 결과가 같다. 이 함수는 참여 행에서 프로그램을
 *    꺼내는 껍데기일 뿐이다.)
 * >>> 서버 dismiss_my_participation(20260821160000)도 같은 조건이다 — 어긋나면 "목록엔 있는데
 *     지워지지 않는 행"이 생긴다.
 */
function isOverItem(it, today) {
  return isProgramOver(it.program, today);
}

export default function QrCenterModal({ onClose }) {
  const tutorial = useTutorial();
  const [items, setItems] = useState([]);
  // 기간제 참여 건의 "오늘까지의 출석 기록" — participation.id -> attendance_sessions 행 배열.
  // 단일 일자 항목은 이 맵에 없다(조회 자체를 하지 않는다).
  const [sessionsByParticipation, setSessionsByParticipation] = useState(() => new Map());
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [active, setActive] = useState(null); // { participation, type, issued, period }
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState('');
  // [지난 활동 — ADR 0025] 끝난 참여는 본 목록에서 빼고 접이식으로 내린다. 기본은 접힘.
  const [pastOpen, setPastOpen] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const rows = await fetchMyParticipationsWithProgram();
      // 확정 A절: 목록은 아직 완료되지 않은 내 참여만. 완료 건은 아카이브의 몫이다.
      // [ADR 0016] waitlisted도 제외한다 — 자리가 확정되지 않아 QR을 받을 자격이 없다(issue_participation_qr/
      // issue_attendance_qr 둘 다 서버에서도 wrong_order로 거부한다 — 이 필터는 UX일 뿐 권한 경계가 아니다).
      // 대기 중이라는 사실 자체는 JoinModal(프로그램 선택 화면)에서 이미 보여준다.
      const active = rows.filter((r) => r.status !== 'completed' && r.status !== 'waitlisted');

      // 기간제 항목만 오늘 액션 판정에 출석 기록이 필요하다(participation.status만으론 "오늘" 상태를 모른다).
      // 데모 규모(참여 몇 건)라 항목당 왕복 1회씩이 무해하다 — 실패해도 목록 자체는 살린다.
      const periodItems = active.filter((r) => r.program?.end_date);
      const sessionLists = await Promise.all(
        periodItems.map((r) =>
          fetchAttendanceSessions(r.id).catch((err) => {
            console.warn('[QrCenterModal] 출석 기록 조회 실패 — 오늘 상태 없이 표시합니다:', err);
            return [];
          })
        )
      );
      setSessionsByParticipation(new Map(periodItems.map((r, i) => [r.id, sessionLists[i]])));
      setItems(active);
      setState('ready');
    } catch (err) {
      // 마이그레이션 미적용/네트워크 오류에도 모달이 죽지 않게 한다.
      console.error('[QrCenterModal] 참여 목록 조회 실패:', err);
      setItems([]);
      setState('error');
    }
  }, []);

  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  // period=true면 기간제 발급 함수(issueAttendanceQr)를, 아니면 기존 issueQr을 부른다.
  // type이 null인 호출은 없다 — periodActionOf가 disabled인 액션에는 type을 null로 주고,
  // 아래 렌더의 버튼도 그 경우 disabled라 클릭 자체가 발생하지 않는다.
  async function openQr(participation, type, period = false) {
    if (busyId || !type) return;
    setBusyId(participation.id);
    setNotice('');
    try {
      const res = period
        ? await issueAttendanceQr({ participationId: participation.id, type })
        : await issueQr({ participationId: participation.id, type });
      if (!res.ok) {
        // 화면 상태가 서버와 어긋난 것이므로 목록을 새로고침한다 (ADR 0005 구현 가이드 2번).
        setNotice(issueRejectText(res.reason));
        await load();
        return;
      }
      setActive({ participation, type, issued: res, period });
    } catch (err) {
      console.error('[QrCenterModal] QR 발급 실패:', err);
      setNotice('QR을 발급하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusyId(null);
    }
  }

  // [끝난 활동을 본 목록에서 뺀다 — 케빈, 2026-08-20]
  //   전에는 "완료되지 않은 내 참여"를 전부 한 줄로 늘어놓아서, 신청만 하고 안 간 활동이 날짜가
  //   한참 지난 뒤에도 '입장 QR' 버튼을 켠 채 남아 있었다(서버는 거부하는데 화면은 권했다).
  //   이제 본 목록은 **오늘 할 일이 있는 것**만 그리고, 끝난 것은 아래 접이식으로 내려간다.
  const { live, past } = useMemo(() => {
    const today = todayISO();
    return {
      live: items.filter((it) => !isOverItem(it, today)),
      past: items.filter((it) => isOverItem(it, today)),
    };
  }, [items]);

  // [지우기는 서버가 판정한다] 화면에서 감추는 것은 다음 기기·다음 로그인에서 되돌아온다.
  //   무엇을 지워도 되는지(포인트 미지급 등)는 dismiss_my_participation() 이 정한다.
  async function handleDismiss(participation) {
    if (busyId) return;
    setBusyId(participation.id);
    setNotice('');
    try {
      const res = await dismissMyParticipation(participation.id);
      if (!res.ok) {
        setNotice(res.message);
        await load(); // 화면 상태가 서버와 어긋난 것이므로 다시 읽는다
        return;
      }
      // 성공하면 그 행만 걷어낸다 — 목록 전체를 다시 읽지 않는다(스크롤이 튀고 접힘이 풀린다).
      setItems((prev) => prev.filter((r) => r.id !== participation.id));
    } finally {
      setBusyId(null);
    }
  }

  function backToList() {
    setActive(null);
    setNotice('');
    load();
  }

  // 목록 행 하나. 본 목록과 "지난 활동"이 같은 행 모양을 쓰고 **오른쪽 버튼만** 갈린다 —
  // 두 벌로 나누면 아이콘·메타 조립 규칙이 갈라진다(ReviewForm 을 하나로 둔 것과 같은 규율).
  const renderItem = (it, over = false) => {
    const v = programView(it.program);
    // 기간제면 periodActionOf가 "오늘" 액션을 결정한다. null이면 단일 일자 — 기존 분기 그대로.
    const period = periodActionOf(it, sessionsByParticipation.get(it.id));
    const isEntry = period ? period.type === 'entry' : it.status === 'applied';
    // [다음 진행일 안내] 오늘 할 일이 없는 기간제 항목(period.note)에만 붙는다 — 오늘
    // 입/퇴장이 가능한 날에는 note가 없다(할 일이 이미 명확하므로 덧붙일 사실이 없다).
    const statusText = over
      ? STATUS_LABEL[it.status] ?? it.status
      : period
        ? [period.label, period.note].filter(Boolean).join(' · ')
        : STATUS_LABEL[it.status] ?? it.status;
    const disabled = busyId === it.id || (period ? period.disabled : false);
    // [ADR 0021] 튜토리얼 참여의 입장/퇴장 버튼만 각각 5·7단계 하이라이트 대상이다.
    // (튜토리얼은 상시 진행이라 over 가 될 수 없다 — isOverItem 참고.)
    const isTutorial = Boolean(it.program?.is_tutorial);
    const tutStep = isTutorial ? (isEntry ? tutorial.isStep(5) && 5 : tutorial.isStep(7) && 7) : undefined;

    return (
      <div className={over ? 'qi over' : 'qi'} key={it.id}>
        <div className="ic" style={{ background: v.soft }}>
          <Icon name={v.icon} size={20} color={v.color} />
        </div>
        <div className="info">
          <h5>{v.title}</h5>
          <div className="m">{[...v.meta, statusText].join(' · ')}</div>
        </div>
        {over ? (
          // 끝난 활동에는 QR 버튼을 그리지 않는다 — 눌러도 서버가 거부하는 버튼을 권하지 않는다.
          <button
            type="button"
            className="qi-dismiss"
            onClick={() => handleDismiss(it)}
            disabled={busyId === it.id}
          >
            {busyId === it.id ? '지우는 중…' : '목록에서 지우기'}
          </button>
        ) : (
          /* 입장 인증 전에는 퇴장 QR 버튼이 아예 뜨지 않는다. 우회해도 서버가 wrong_order 로 막는다.
             기간제는 periodActionOf가 이미 "오늘 할 수 있는 것" 하나로 좁혀서 같은 규칙이 유지된다. */
          <button
            type="button"
            className={isEntry ? 'scanbtn enter' : 'scanbtn exit'}
            onClick={() => openQr(it, period ? period.type : isEntry ? 'entry' : 'exit', Boolean(period))}
            disabled={disabled}
            data-tutorial={tutStep || undefined}
          >
            {busyId === it.id ? '발급 중…' : period ? period.label : isEntry ? '입장 QR' : '퇴장 QR'}
          </button>
        )}
      </div>
    );
  };

  return (
    <Modal onClose={onClose} labelledBy="qr-title">
      {active ? (
        <QrView
          participation={active.participation}
          type={active.type}
          issued={active.issued}
          period={active.period}
          onBack={backToList}
          onClose={onClose}
        />
      ) : (
        <div className="mbody">
          <span className="qtag exit">QR 인증</span>
          {/* [제목이 "발급된 QR"이 아닌 이유 — 2026-08-14 수정]
              이 화면에는 QR이 하나도 없다. 참여 중인 활동 목록이고, 버튼을 눌러야 그때 서버가
              토큰을 발급한다(issue_participation_qr). "발급된 QR"이라고 써 두면 제목과 화면이
              어긋나 학생이 "QR이 어디 있지"부터 찾는다. */}
          <h3 id="qr-title" style={{ marginBottom: 4 }}>
            입·퇴장 인증
          </h3>
          {/* [현장 리더기가 아니다 — 같은 날 수정] 무인 단말기는 없다. 관리자가 자기 휴대폰
              카메라로 스캔한다(AdminScanPage). 튜토리얼 5단계는 이미 "관리자가 카메라로 스캔해"라고
              바르게 말하고 있어서, 이 줄만 앱 안에서 다른 이야기를 하고 있었다.
              >>> 이 문구를 고칠 일이 생기면 TutorialContext 5·6단계와 함께 볼 것 — 같은 사실을
                  말하는 두 자리다. */}
          <p className="qr-lead">
            참여 중인 활동 목록이에요. 버튼을 누르면 QR이 만들어지고, 그 화면을 관리자에게 보여주면
            카메라로 스캔해 입장·퇴장이 인증됩니다.
          </p>

          {notice && <div className="qr-notice">{notice}</div>}

          {state === 'loading' && <div className="empty">참여 목록을 불러오는 중…</div>}

          {state === 'error' && (
            <div className="empty">
              참여 목록을 불러오지 못했어요.
              <br />
              잠시 후 다시 시도해 주세요.
            </div>
          )}

          {state === 'ready' && items.length === 0 && (
            // 빈 상태도 같은 오해를 반복했다("발급된 QR이 없습니다") — 발급 전이라 없는 게 아니라
            // **인증할 활동이 없는** 것이다. 이모지 없음은 프로토타입 1005줄 규율 그대로.
            <div className="empty">
              인증할 활동이 없습니다.
              <br />
              프로그램에 신청하면 여기에서 입·퇴장을 인증할 수 있어요.
            </div>
          )}

          {/* 본 목록 — 오늘 할 일이 있는 활동만 (ADR 0025). 끝난 것은 아래 접이식으로 내려간다. */}
          {state === 'ready' && live.length > 0 && (
            <div className="qrlist">{live.map((it) => renderItem(it))}</div>
          )}

          {/* [끝난 활동이 하나도 없으면 이 줄 자체가 없다] 항상 떠 있으면 "정리할 게 있나?"를 매번
              확인하게 만든다 — 할 일이 있을 때만 나타나는 자리다. */}
          {state === 'ready' && past.length > 0 && (
            <div className="qr-fold">
              <button
                type="button"
                className="qr-foldbtn"
                aria-expanded={pastOpen}
                onClick={() => setPastOpen((o) => !o)}
              >
                <Icon name="ic-clock" size={15} />
                지난 활동
                <span className="cnt">{past.length}건</span>
                <span className={pastOpen ? 'chev on' : 'chev'} aria-hidden="true" />
              </button>
              {pastOpen && (
                <>
                  {/* 지우면 무엇이 사라지는지 먼저 말한다 — 되돌릴 수 없는 행동이다. */}
                  <p className="qr-foldnote">
                    진행이 끝나 인증할 수 없는 활동이에요. 지우면 이 목록에서 사라집니다.{' '}
                    <b>완료한 활동과 포인트를 받은 활동은 아카이브에 그대로 남아요.</b>
                  </p>
                  <div className="qrlist past">{past.map((it) => renderItem(it, true))}</div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ==========================================================================
   QR 표시 (프로토타입 .qrbox 구조 재사용)
   ========================================================================== */

function mmss(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function QrView({ participation, type, issued: initialIssued, period, onBack, onClose }) {
  const isEntry = type === 'entry';
  const v = programView(participation.program);
  // [ADR 0021] 관리자 스캔 대신 학생 화면이 직접 verify_tutorial_qr()을 부르는 참여인지.
  const isTutorial = Boolean(participation.program?.is_tutorial);

  // [기간제 지급 방식 — 20260809160000] 카드/QR 목록과 같은 필드(participation.program.attendance_payout_mode).
  // period=true인데도 값이 없으면(레거시 데이터) 'full'로 취급한다 — DB가 백필해두지만 프런트도 fail-safe.
  const payoutMode = period ? participation.program?.attendance_payout_mode ?? 'full' : null;

  const { refreshProfile } = useAuth();
  const tutorial = useTutorial();
  const [issued, setIssued] = useState(initialIssued);
  const [now, setNow] = useState(() => Date.now());
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const doneRef = useRef(false);
  // 퇴장 완료 화면의 만족도 평가 (CLAUDE.md 6장 3번). 'open' = 자동 노출 상태.
  // [QR 상태와 섞지 않는다] 이 값은 done/issued/폴링에 아무 영향을 주지 않는다 — 평가는 QR 흐름의 곁가지다.
  const [reviewState, setReviewState] = useState('open'); // 'open' | 'saved' | 'skipped'
  // [완료 여부는 서버 판정을 그대로 옮겨온다 — 날짜 비교로 추정하지 않는다]
  //   full 모드는 "종료일 퇴장"이 곧 완료지만, threshold 모드는 종료일 전에 완료될 수 있고, per_session
  //   모드는 매 퇴장마다 지급되면서도 완료(=participations.status)는 여전히 종료일에만 일어난다.
  //   그래서 폴링이 이 QR의 참여 건 전체 상태(fetchParticipationStatuses)를 함께 확인해 결과를 여기 담는다.
  //   pointsAwarded: 이번 퇴장에서 포인트가 지급됐는가(화면에 +P 를 보일지).
  //   fullyCompleted: 이번 퇴장으로 참여 전체가 끝났는가(평가폼·"확인" 버튼을 보일지).
  const [exitOutcome, setExitOutcome] = useState({ pointsAwarded: false, fullyCompleted: false });

  const payload = useMemo(() => buildQrPayload(issued), [issued]);
  const expiresMs = Date.parse(issued.expires_at);
  const remaining = Number.isNaN(expiresMs) ? 0 : expiresMs - now;
  const expired = remaining <= 0;
  // [만료 임박 경고 — ADR 0018, 2026-08-11] 30분 내내 같은 회색이다가 0초에 갑자기 "지났습니다"로 바뀌면,
  // 늦게 온 학생은 QR을 스캔대에 대는 순간 처음 만료를 알게 된다. 마지막 5분은 색을 바꿔 미리
  // 눈에 띄게 한다 — 판정 자체는 여전히 서버(*_token_expires_at)가 한다, 이건 표시일 뿐이다.
  const WARN_MS = 5 * 60 * 1000;
  const warn = !expired && remaining <= WARN_MS;

  // 남은 유효시간 1초 틱. 이 값은 "표시"일 뿐 판정이 아니다 —
  // 만료 판정의 소유자는 서버의 *_token_expires_at 컬럼이다 (ADR 0005 결정 1-3).
  useEffect(() => {
    if (done) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [done]);

  // 상태 확인 1회. 주기 폴링과 "화면 복귀 시 즉시 확인"이 같은 함수를 부른다.
  // [의존성이 전부 안정값이다] 아래 폴링 effect 가 1초 카운트다운 리렌더마다 재시작하면
  //   빠른 구간(2분)이 영원히 갱신돼 느려지지 않는다. refreshProfile 은 AuthContext 의 useCallback([]) 이다.
  const checkOnce = useCallback(async () => {
    if (doneRef.current) return;
    const target = isEntry ? 'entered' : 'completed';
    try {
      if (period) {
        // [기간제] 참여 전체(status)가 아니라 "이 QR이 발급된 그날"의 세션 상태를 본다 —
        //   participation.status 는 첫날 입장~마지막날 퇴장까지 내내 'entered' 그대로라 오늘 상태를 못 말해준다.
        const sessions = await fetchAttendanceSessions(participation.id);
        const mine = sessions.find((s) => s.session_date === issued.session_date);
        if (!mine || doneRef.current) return;
        if (mine.status !== target) return;

        doneRef.current = true;

        if (isEntry) {
          setDone(true);
          return;
        }

        // 퇴장 — 참여 전체가 이번에 끝났는지는 participations.status 를 다시 봐야 안다(위 주석 참고).
        let fullyCompleted = false;
        try {
          const rows = await fetchParticipationStatuses();
          fullyCompleted = rows.find((r) => r.id === participation.id)?.status === 'completed';
        } catch (err) {
          console.warn('[QrCenterModal] 참여 완료 여부 확인 실패(완료 화면만 단순화됨):', err);
        }
        // per_session 은 완료 여부와 무관하게 이번 퇴장에서 항상 지급된다(서버가 매번 지급).
        // threshold/full 은 "이번 퇴장으로 완료됐을 때"만 지급된 것이다.
        const pointsAwarded = payoutMode === 'per_session' || fullyCompleted;
        setExitOutcome({ pointsAwarded, fullyCompleted });
        setDone(true);
        if (pointsAwarded) {
          refreshProfile?.().catch((err) =>
            console.warn('[QrCenterModal] 잔액 갱신 실패(표시만 지연됨):', err)
          );
        }
        return;
      }

      const rows = await fetchParticipationStatuses();
      const mine = rows.find((r) => r.id === participation.id);
      if (!mine || doneRef.current) return;
      if (mine.status === target || (isEntry && mine.status === 'completed')) {
        doneRef.current = true;
        setDone(true);
        // 퇴장 인증이 끝나면 서버가 points_balance 를 올린 상태다. 전역 profile 을 다시 읽어
        // 나브 상단 잔액을 맞춘다 — 안 하면 완료 화면엔 "+400P 적립"이 뜨는데 나브는 그대로라
        // "포인트가 안 들어왔다"로 보인다. 프런트가 값을 계산하는 게 아니라 서버 값을 재조회한다.
        if (!isEntry) {
          setExitOutcome({ pointsAwarded: true, fullyCompleted: true });
          refreshProfile?.().catch((err) =>
            console.warn('[QrCenterModal] 잔액 갱신 실패(표시만 지연됨):', err)
          );
        }
      }
    } catch (err) {
      // 폴링 실패는 조용히 넘어간다 — 다음 주기에 다시 시도한다. QR 자체는 여전히 유효하다.
      console.warn('[QrCenterModal] 상태 폴링 실패:', err);
    }
  }, [isEntry, participation.id, refreshProfile, period, issued.session_date, payoutMode]);

  // 폴링 — 관리자가 스캔하면 화면이 자동으로 완료 상태로 넘어간다.
  // setInterval 이 아니라 자기 자신을 다시 예약하는 setTimeout 이다: 주기가 도중에 바뀌고(2초 -> 10초),
  // 이전 요청이 끝난 뒤에 다음을 잡아 느린 네트워크에서 요청이 겹쳐 쌓이지 않는다.
  // issued.token 이 의존성에 있어 "다시 발급받기"를 누르면 빠른 구간이 새로 시작된다(= 다시 스캔할 상황).
  useEffect(() => {
    // [ADR 0021] 튜토리얼은 관리자가 스캔할 일이 없다 — 폴링할 대상(관리자의 스캔 행위)이 애초에
    // 없으므로 이 효과 자체를 돌리지 않는다. 아래 별도 효과가 검증을 직접 부른다.
    if (done || isTutorial) return undefined;
    const startedAt = Date.now();
    let timer = null;

    const tick = async () => {
      await checkOnce();
      if (doneRef.current) return;
      const fast = Date.now() - startedAt < POLL_FAST_WINDOW_MS;
      timer = setTimeout(tick, fast ? POLL_FAST_MS : POLL_SLOW_MS);
    };
    timer = setTimeout(tick, POLL_FAST_MS);

    // 폰을 잠갔다 켜면 그동안 타이머가 억제됐을 수 있다. 돌아온 즉시 한 번 확인한다.
    const onVisible = () => {
      if (document.visibilityState === 'visible') checkOnce();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [done, isTutorial, checkOnce, issued.token]);

  // [ADR 0021] 튜토리얼 셀프 검증 — 관리자 스캔 대신 이 효과가 직접 verify_tutorial_qr()을 부른다.
  // 나머지(exitOutcome 조립·profile 잔액 새로고침·done 전환)는 위 checkOnce의 성공 분기와 같은 결과를
  // 만든다 — "누가 검증을 트리거했는가"만 다르고 그 뒤 화면 흐름은 동일해야 두 경로가 갈라지지 않는다.
  useEffect(() => {
    if (!isTutorial || done) return undefined;
    const timer = setTimeout(async () => {
      if (doneRef.current) return;
      try {
        const res = await verifyTutorialQr(issued.token);
        if (doneRef.current) return;
        if (!res.ok) {
          // 정상 경로에선 사실상 발생하지 않는다(막 발급받은 토큰이라서다) — 그래도 조용히 넘기지 않는다.
          setNotice('자동 인증에 실패했어요. "다시 발급받기" 없이도 목록에서 다시 시도할 수 있어요.');
          return;
        }
        doneRef.current = true;
        if (isEntry) {
          setDone(true);
          return;
        }
        setExitOutcome({ pointsAwarded: true, fullyCompleted: true });
        setDone(true);
        refreshProfile?.().catch((err) =>
          console.warn('[QrCenterModal] 잔액 갱신 실패(표시만 지연됨):', err)
        );
        // [ADR 0021] 8단계("만족도·한줄평 입력")는 리뷰폼이 실제로 뜨는 이 시점에 넘긴다 — 클릭
        // 기반이 아니라 여기서 명시적으로 부르는 이유는, 직전 클릭(퇴장 QR)이 이미 7단계를 넘겼고
        // 8단계로 넘어갈 자연스러운 다음 클릭이 없기 때문이다(리뷰폼 자체를 감시하면 별점을 눌러
        // 보기만 해도 넘어가 버린다 — 실제로 제출/건너뛰기 전까지는 근사치조차 부정확해진다).
        if (tutorial.isStep(7)) tutorial.advance();
      } catch (err) {
        console.error('[QrCenterModal] 튜토리얼 자동 인증 실패:', err);
        setNotice('자동 인증에 실패했어요. 잠시 후 다시 시도해 주세요.');
      }
    }, TUTORIAL_AUTO_VERIFY_MS);
    return () => clearTimeout(timer);
  }, [isTutorial, done, isEntry, issued.token, refreshProfile, tutorial]);

  async function reissue() {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      // 재발급 = 같은 발급 함수 재호출(기간제는 issueAttendanceQr). 서버가 새 토큰으로 덮어쓰고
      // 이전 토큰은 즉시 무효가 된다. 날짜는 여전히 서버가 "오늘"로 계산하므로 인자로 넘기지 않는다.
      const res = period
        ? await issueAttendanceQr({ participationId: participation.id, type })
        : await issueQr({ participationId: participation.id, type });
      if (!res.ok) {
        setNotice(issueRejectText(res.reason));
        return;
      }
      setIssued(res);
      setNow(Date.now());
    } catch (err) {
      console.error('[QrCenterModal] QR 재발급 실패:', err);
      setNotice('QR을 다시 발급하지 못했습니다. 잠시 후 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="mbody">
        <div className="scan-done">
          <div className="check">
            <Icon name="ic-check" size={38} />
          </div>
          {/* [원칙 4] 큰 문구는 언제나 포트폴리오 서사다. 포인트는 아래 한 줄 보조로만 놓는다.
              [기간제 — 참여 전체가 안 끝난 퇴장] "참여가 기록되었습니다"(완료를 암시)를 쓰지 않는다.
              exitOutcome.fullyCompleted 가 그 경계다 — 지급 방식(full/per_session/threshold)마다
              "언제 끝나는가"가 다르므로 날짜 비교가 아니라 서버가 돌려준 참여 상태로 판정한다. */}
          <h3 id="qr-title">
            {isEntry
              ? '입장이 확인되었습니다'
              : exitOutcome.fullyCompleted
                ? '참여가 기록되었습니다'
                : '오늘 출석이 기록되었습니다'}
          </h3>
          <div className="desc">
            {isEntry
              ? `${v.title} · ${period ? '오늘 ' : ''}퇴장 시 한 번 더 인증해 주세요`
              : exitOutcome.fullyCompleted
                ? v.title
                : `${v.title} · 종료일까지 계속 인증해 주세요`}
          </div>
          {/* 지급 포인트는 클라이언트가 이미 들고 있는 programs.points 로 그린다(폴링은 금액을 돌려주지 않는다).
              amber·작게. 숫자 카운트업/컨페티/사운드 금지 (원칙 1·4).
              [기간제] exitOutcome.pointsAwarded 가 실제 지급 여부다 — per_session 모드는 완료 전에도
              매번 지급되므로 fullyCompleted 와 별개로 여기서 보인다. full/threshold 는 완료된 순간에만 같이 켜진다. */}
          {exitOutcome.pointsAwarded && v.points != null && <div className="done-pts">+{v.points}P 적립</div>}

          {/* [CLAUDE.md 6장 3번 — 퇴장 인증 완료 시 만족도 평가 자동 노출]
              별도 모달을 겹치지 않는다. 이미 모달 안이므로 같은 mbody 에서 이어서 보여준다(스펙 결정 D-1).
              [입장 완료·참여가 아직 안 끝난 날에는 노출하지 않는다] fullyCompleted 가 아니면 평가를 묻지
              않는다 — per_session 모드로 매일 지급받아도 참여 자체가 끝나기 전엔 "어떠셨나요"를 물을 시점이
              아니다(리뷰는 활동 전체에 대한 평가이지 하루치 평가가 아니다).
              [건너뛰기 필수] 평가를 강제하면 현장에서 모달을 못 닫는 상황이 생기고, 그건 QR 2회 인증
              (원칙 5)의 신뢰를 깎는다. 건너뛴 활동은 아카이브에서 "평가 미작성"으로 남는다. */}
          {exitOutcome.fullyCompleted && reviewState === 'open' && (
            <div className="qr-review">
              <ReviewForm
                participationId={participation.id}
                onSaved={() => {
                  setReviewState('saved');
                  // [ADR 0021 — 버그 수정] 8단계("만족도·한줄평 입력")에서 9단계로 넘기는 호출이
                  // 빠져 있었다 — 저장/건너뛰기 어느 쪽도 트래커를 진행시키지 않아 8단계에서 멈췄다.
                  if (isTutorial && tutorial.isStep(8)) tutorial.advance();
                }}
                onSkip={() => {
                  setReviewState('skipped');
                  if (isTutorial && tutorial.isStep(8)) tutorial.advance();
                }}
              />
            </div>
          )}
          {exitOutcome.fullyCompleted && reviewState === 'saved' && (
            <div className="qr-reviewdone">평가가 저장되었어요 · 아카이브에 함께 기록됩니다</div>
          )}
          {exitOutcome.fullyCompleted && reviewState === 'skipped' && (
            <div className="qr-reviewdone muted">평가는 아카이브에서 언제든 남길 수 있어요</div>
          )}

          {/* [ADR 0021] 튜토리얼 입장 완료 화면의 "목록으로"만 6단계 하이라이트 대상이다 — 그 시점엔
              입장이 이미 자동 인증돼 있으므로, 이 버튼을 누르는 것이 곧 "7단계(퇴장 QR)로 넘어가겠다"는
              뜻이다. */}
          <button
            type="button"
            className="mbtn"
            style={{ marginTop: 22 }}
            onClick={isEntry || !exitOutcome.fullyCompleted ? onBack : onClose}
            data-tutorial={isTutorial && isEntry && tutorial.isStep(6) ? 6 : undefined}
          >
            {isEntry || !exitOutcome.fullyCompleted ? '목록으로' : '확인'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mbody">
      <div className="qrbox">
        <span className={isEntry ? 'qtag' : 'qtag exit'}>
          {period ? '오늘 ' : ''}
          {isEntry ? '입장' : '퇴장'} 인증
        </span>

        {/* [level M -> Q] payload 가 토큰 10자(영숫자)로 줄어 QR 버전 1(21×21)에 들어간다.
            버전 1 영숫자 용량은 Q 에서 16자라 10자는 여유가 있다 — 즉 격자를 더 키우지 않고
            오류 정정만 15% -> 25% 로 올린 것이다. 지문·화면 반사·기울임에 그만큼 강해진다. */}
        <div className={expired ? 'qr is-expired' : 'qr'} style={{ marginTop: 14 }}>
          <QRCodeSVG value={payload} size={164} level="Q" bgColor="#FFFFFF" fgColor="#16213E" />
        </div>

        <h3 id="qr-title" style={{ marginTop: 16 }}>
          {v.title}
        </h3>
        <div className="desc">
          {/* "현장의 QR 리더기에 인식시켜 주세요" 였다 — 무인 단말기는 없다(2026-08-14 수정).
              QR 을 실제로 읽는 주체는 관리자의 휴대폰 카메라다(AdminScanPage). */}
          {isTutorial ? '잠시만 기다려 주세요, 자동으로 인증됩니다.' : '관리자에게 이 화면을 보여주세요.'}
        </div>

        {/* [ADR 0021 — 튜토리얼 전용 안내] "QR 옆에" 자동 인증 사실을 명시한다. 실제 참여의 카운트다운/
            만료/재발급/수동 코드 UI는 여기서 의미가 없다 — 발급 후 TUTORIAL_AUTO_VERIFY_MS 안에 이미
            끝난다. 그 UI들을 그대로 두면 "30분 안에 스캔하세요"라는 거짓 정보가 된다. */}
        {isTutorial ? (
          <div className="qr-tutorial-note" role="status">
            이 프로그램은 튜토리얼이라 자동 인증됩니다. 실제 활동은 관리자가 QR을 직접 스캔해요.
          </div>
        ) : expired ? (
          <>
            <div className="countdown expired">유효시간이 지났습니다</div>
            <button type="button" className="qr-reissue" onClick={reissue} disabled={busy}>
              <Icon name="ic-refresh" size={16} />
              {busy ? '발급 중…' : '다시 발급받기'}
            </button>
          </>
        ) : (
          <div className={warn ? 'countdown warn' : 'countdown'}>
            <span className={warn ? 'cdn warn' : 'cdn'}>{mmss(remaining)}</span>
            {warn ? '남음 · 곧 만료돼요, 스캔이 늦어지면 다시 발급받으세요' : '남음 · 시간이 지나면 다시 발급받을 수 있어요'}
          </div>
        )}

        {/* 수동 확인용 코드. 학생은 검증 RPC 호출 권한이 없으므로 자기 토큰을 알아도 스스로 인증할 수 없다
            (스펙 "시연 환경 전제"). 웹캠 인식이 실패할 때 관리자가 이 코드를 직접 입력한다(확정 D-1).
            [튜토리얼은 숨긴다] 스스로 검증하는 참여라 "수동 확인용 코드"라는 문구 자체가 성립하지 않는다. */}
        {!isTutorial && (
          <div className="qr-code-text">
            코드 <b>{issued.token}</b>
          </div>
        )}

        {notice && <div className="qr-notice">{notice}</div>}

        <button type="button" className="qr-back" onClick={onBack}>
          목록으로
        </button>
      </div>
    </div>
  );
}
