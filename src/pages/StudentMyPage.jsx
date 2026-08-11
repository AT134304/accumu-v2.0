// Accumu v2 — 마이페이지 (docs/specs/student-archive-mypage.md B절 / 확정 F·J·K-1, ADR 0007)
// Accumu_prototype.html screen-mypage(630~666줄) + openConvert()의 구조·카피를 재현한다.
//
// [보존 대상 — 확정 J. 이 두 개가 사라지면 1인 시연이 불가능해진다]
//   1. "QR 확인 · 입퇴장 인증"(QrCenterModal 진입점, indigo) — 확정 F-1 이 QR 진입점을 이 화면에 심었다.
//   2. 로그아웃 — 케빈이 학생/관리자 계정을 오가는 유일한 수단이다(나브에 없다).
//   그래서 placeholder 를 걷어내면서 이 둘을 먼저 배치하고 나머지를 채웠다.
//
// [절대 원칙 4 — 이 화면은 유일하게 포인트가 주인공인 화면인데도 순서를 지킨다]
//   .my-grid 의 DOM 순서가 프로필(성장·brand blue) -> 포인트(amber)다. 모바일 1열에서 프로필 카드가 위로 온다.
//   프로필 카드 안에 "내 활동 아카이브 보기" 동선을 둬서 포인트보다 포트폴리오가 먼저 읽히게 한다.
//
// [프로토타입에서 의도적으로 빼거나 바꾼 것]
//   - 학교/학년/가입일 행(639~641줄): profiles 에 그 컬럼이 없다(ADR 0002). created_at 은 시딩 시각이지
//     가입일이 아니다. 없는 정보를 그럴듯하게 지어내지 않는다 -> 학번 한 줄만 남긴다.
//   - 잔액 카운트업 애니메이션(animateNum): 숫자가 차오르는 연출은 게임적 요소다(원칙 1). 정적 표시.
//   - "분야별 획득 포인트" 막대(.fieldpts, 664줄): 결정 H 가 기각. 대신 원장 목록(PointLedger)을 둔다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTutorial } from '../context/TutorialContext';
import Icon from '../components/Icon';
import Toast from '../components/Toast';
import QrCenterModal from '../components/student/QrCenterModal';
import PointLedger from '../components/student/PointLedger';
import PasswordChangeForm from '../components/PasswordChangeForm';
import { TRACK } from '../lib/taxonomy';
import { describePending, fetchMyPointLedger, settleMyPoints } from '../lib/pointService';
import { linkSchoolAccount, setCareerInterest } from '../lib/profileService';
import '../styles/Qr.css';
import '../styles/StudentMyPage.css';

export default function StudentMyPage() {
  // session 은 개인 계정의 이메일 표시에만 쓴다(profiles 에 email 컬럼이 없다 — auth.users 가 소유).
  const { profile, session, signOut, applyProfilePatch } = useAuth();
  const tutorial = useTutorial();

  const [qrOpen, setQrOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [toast, setToast] = useState(null); // { key, message }

  // 지역화폐 정산 (ADR 0012). pending = 아직 전환되지 않은 달들. null = 아직 못 읽음.
  const [pending, setPending] = useState(null);

  // 원장은 잔액과 독립적으로 실패해야 한다 — 내역을 못 읽었다고 포인트 카드가 사라지면 안 된다(스펙 에러 처리).
  const [ledger, setLedger] = useState([]);
  const [ledgerState, setLedgerState] = useState('loading'); // 'loading' | 'ready' | 'error'

  const [savingTrack, setSavingTrack] = useState(undefined); // undefined = 저장 중 아님 (null 은 "해제 저장 중")
  const [trackError, setTrackError] = useState('');

  // 학교 계정 연동 (ADR 0008). 개인 계정일 때만 입력이 열린다.
  const [invite, setInvite] = useState('');
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState('');
  const isSchool = profile?.account_type === 'school';

  // 언마운트 후 setState 를 막는다. 원장은 마운트 시 1회 + 전환 성공/QR 모달 닫힘에서 다시 읽으므로
  // 조회 중에 화면을 떠날 수 있다(다른 화면들의 cancelled 플래그와 같은 목적, 호출 지점이 여럿이라 ref).
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadLedger = useCallback(async () => {
    setLedgerState('loading');
    try {
      // point_transactions_select_own 이 소유자다 — student_id 를 클라이언트에서 걸지 않는다.
      const rows = await fetchMyPointLedger();
      if (!alive.current) return;
      setLedger(rows);
      setLedgerState('ready');
    } catch (err) {
      // 조회 실패는 "내역 0건"과 다른 상태다. 빈 상태 문구를 실패에 쓰지 않는다.
      console.error('[StudentMyPage] 포인트 내역 조회 실패:', err);
      if (!alive.current) return;
      setLedger([]);
      setLedgerState('error');
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadLedger();
    })();
  }, [loadLedger]);

  // [정산은 화면이 열릴 때 서버가 판정한다 — ADR 0012]
  //   프런트가 "말일이 지났는가"를 계산하지 않는다. 계산하면 서버와 클라이언트가 서로 다른 "이번 달"을 갖는다.
  //   멱등이라 매번 호출해도 안전하다(같은 달 두 번째 정산은 unique 제약이 막는다).
  //   정산이 실제로 일어났으면 잔액 3종이 바뀌었으므로 전역 profile 과 원장을 함께 맞춘다.
  const settle = useCallback(async () => {
    try {
      const res = await settleMyPoints();
      if (!alive.current) return;
      setPending(res.pending ?? []);
      applyProfilePatch({
        points_balance: res.points_balance,
        points_total: res.points_total,
        currency_balance: res.currency_balance,
      });
      if ((res.settled ?? []).length > 0) {
        const sum = res.settled.reduce((acc, r) => acc + Number(r.amount ?? 0), 0);
        setToast({ key: Date.now(), message: `₩${sum.toLocaleString()} 지역화폐로 전환되었어요` });
        await loadLedger(); // 방금 생긴 '전환' 행이 내역에 바로 보여야 한다
      }
    } catch (err) {
      // 조용히 삼키지 않되 화면을 막지도 않는다 — 정산은 다음 방문에 다시 시도된다(멱등).
      console.error('[StudentMyPage] 지역화폐 정산 실패:', err);
      if (alive.current) setPending([]);
    }
  }, [applyProfilePatch, loadLedger]);

  useEffect(() => {
    if (!profile?.id) return;
    // loadLedger 와 같은 형태 — setState 가 await 뒤에서만 일어난다는 것을 호출부에서도 드러낸다.
    (async () => {
      await settle();
    })();
  }, [profile?.id, settle]);

  const balance = profile?.points_balance ?? 0;
  const total = profile?.points_total ?? 0;
  const currency = profile?.currency_balance ?? 0;

  // 저장 중에는 서버 응답 대신 "지금 저장하려는 값"을 보여준다. 실패하면 이 값을 버리는 것만으로
  // 이전 값으로 돌아간다(별도 롤백 코드 없음) — profile 은 서버가 확인해 준 값만 담는다.
  const currentTrack = savingTrack !== undefined ? savingTrack : profile?.career_interest ?? null;

  async function handleTrack(key) {
    if (savingTrack !== undefined) return;
    const next = currentTrack === key ? null : key; // 같은 칩을 다시 누르면 해제(확정 K-1: 단일 선택)
    setSavingTrack(next);
    setTrackError('');
    try {
      const res = await setCareerInterest(next);
      // 홈 추천은 [profile] 의존 useEffect 로 다시 계산된다 — 여기서 갱신하지 않으면 계열을 바꿔도
      // 추천이 그대로다(스펙 이슈 3). reload() 로 때우지 않는다.
      applyProfilePatch({ career_interest: res?.career_interest ?? null });
    } catch (err) {
      // 조용히 삼키지 않는다. 삼키면 "홈 추천이 이유 없이 안 바뀌는" 상태가 된다.
      console.error('[StudentMyPage] 관심 계열 저장 실패:', err);
      setTrackError('관심 계열을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setSavingTrack(undefined);
    }
  }

  // 개인 -> 학교 연동. 성공하면 서버가 돌려준 account_type 으로 전역 profile 을 덮는다(이슈 3과 같은 규율).
  async function handleLink(e) {
    e.preventDefault();
    if (linking) return;
    const code = invite.trim();
    if (!code) {
      setLinkError('초대코드를 입력해주세요.');
      return;
    }
    setLinking(true);
    setLinkError('');
    try {
      const res = await linkSchoolAccount(code);
      if (res.ok) {
        applyProfilePatch({ account_type: res.account_type });
        setInvite('');
        setToast({ key: Date.now(), message: '학교 계정으로 연동되었어요' });
        return;
      }
      if (res.reason === 'already_linked') {
        // 오류가 아니라 이미 도달한 상태다. 화면을 서버 값에 맞춰 정리하고 문구만 알린다.
        applyProfilePatch({ account_type: 'school' });
        setLinkError('이미 학교 계정으로 연동되어 있어요.');
        return;
      }
      if (res.reason === 'rate_limited') {
        // [ADR 0017] 무차별 대입 완화. 정답을 넣었어도 잠금 중엔 여기로 온다 — "코드가 틀렸다"고
        // 말하면 거짓이 되므로 다른 문구를 쓴다. 분 단위로만 보여준다(초 단위 카운트다운은 굳이
        // 필요 없는 정밀도이고, 이 값을 서버 판정 대신 쓰지 않는다 — 재시도하면 서버가 다시 막는다).
        const mins = Math.max(1, Math.ceil((new Date(res.retry_after).getTime() - Date.now()) / 60000));
        setLinkError(`너무 여러 번 시도했어요. ${mins}분 후 다시 시도해 주세요.`);
        return;
      }
      setLinkError('초대코드를 확인해주세요. 담당 선생님께 받은 코드를 그대로 입력해주세요.');
    } catch (err) {
      // 조용히 삼키지 않는다 — 입력값은 그대로 두고 다시 시도할 수 있게 한다.
      console.error('[StudentMyPage] 학교 계정 연동 실패:', err);
      setLinkError('연동하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setLinking(false);
    }
  }

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <section className="screen my-screen">
      <div className="sec-head">
        <div>
          <div className="eyebrow">My page</div>
          <h2 className="sec">마이페이지</h2>
          <div className="sec-sub">나의 정보와 모은 포인트를 확인하세요</div>
        </div>
      </div>

      <div className="my-grid">
        {/* ---------- 프로필 (좌 / 모바일 위) ---------- */}
        <div className="profile">
          <div className="pbanner" />
          <div className="pmain">
            {/* 아바타는 정적 이니셜이다 — 레벨/성장 요소가 아니다(원칙 1, 셸 아바타와 같은 규율). */}
            <div className="pav" aria-hidden="true">
              {profile?.name?.trim()?.[0] ?? ''}
            </div>
            <h3>{profile?.name ?? ''}</h3>
            <div className="role">학생 · 진로 탐색 중</div>

            {/* [개인 계정에는 학번이 없다] 학번은 학교가 부여하는 값이라 소속이 없으면 존재하지 않는다.
                그 자리에 로그인 아이디(이메일)를 보여준다 — profiles.code(P-XXXXXX)는 서버가 발급한
                내부 식별자라 외우거나 불러줄 값이 아니다. 이메일이 없는 소셜 계정만 그 값을 대신 쓴다. */}
            <div className="prows">
              <div className="prow">
                <span className="k">{isSchool ? '학번' : '이메일'}</span>
                <span className="v">
                  {isSchool ? profile?.code ?? '' : session?.user?.email ?? profile?.code ?? ''}
                </span>
              </div>
            </div>

            <div className="trackpick">
              <div className="tp-label">
                <Icon name="ic-target" size={14} color="var(--brand)" />
                관심 진로 계열
              </div>
              <div className="tp-note">
                {currentTrack
                  ? '선택한 계열은 메인 화면 추천에 바로 반영돼요'
                  : '아직 설정하지 않았어요 · 설정하기'}
              </div>
              <div className="chiprow">
                {Object.entries(TRACK).map(([key, t]) => (
                  <button
                    key={key}
                    type="button"
                    className={currentTrack === key ? 'chip on' : 'chip'}
                    aria-pressed={currentTrack === key}
                    disabled={savingTrack !== undefined}
                    onClick={() => handleTrack(key)}
                  >
                    <i className="chipdot" style={{ background: t.color }} />
                    {t.name}
                  </button>
                ))}
              </div>
              {trackError && (
                <div className="tp-err" role="alert">
                  {trackError}
                </div>
              )}
            </div>

            {/* 학교 계정 연동 (docs/specs/auth-signup.md C / ADR 0008 결정 5)
                [해제 버튼이 없다] school -> personal 은 mentor_students delete 경로가 필요하고, 그건
                학생이 자기 기록을 관리자 시야에서 지울 수 있게 만드는 일이다(스펙 "스코프 아님"). */}
            <div className="linkbox">
              {isSchool ? (
                <div className="linked">
                  <Icon name="ic-school" size={14} color="var(--brand)" />
                  학교 계정 · 담당 선생님과 연동됨
                </div>
              ) : (
                <form onSubmit={handleLink}>
                  <div className="tp-label">
                    <Icon name="ic-school" size={14} color="var(--brand)" />
                    학교 계정 연동
                  </div>
                  <div className="tp-note">선생님께 받은 초대코드를 입력하면 담당 선생님과 연동돼요.</div>
                  <div className="linkrow">
                    <input
                      value={invite}
                      placeholder="예: SCH-1A2B"
                      disabled={linking}
                      onChange={(e) => setInvite(e.target.value)}
                      aria-label="학교 초대코드"
                    />
                    <button type="submit" disabled={linking}>
                      {linking ? '연동 중…' : '연동'}
                    </button>
                  </div>
                  {linkError && (
                    <div className="tp-err" role="alert">
                      {linkError}
                    </div>
                  )}
                </form>
              )}
            </div>

            {/* 비밀번호 변경 (ADR 0020) — 학교/개인/소셜 계정 공통. 자세한 건 컴포넌트 주석 참고. */}
            <PasswordChangeForm />

            {/* [보존 — 확정 J·F-1] 위치(계열 칩 아래)·카피·indigo 색 모두 프로토타입 652줄 그대로.
                신청 직후에 QR 을 발급하지 않는 규율도 그대로다(토큰 30분 만료).
                [ADR 0021 — 버그 수정] 하이라이트 전용(data-tutorial-pre) — 5단계의 진짜 목표는 QR
                센터 안의 "입장 QR" 버튼(data-tutorial="5")이다. 이 버튼을 진행 트리거로 삼으면
                모달을 여는 순간(아직 QR도 안 열었는데) 6단계로 잘못 넘어간다. */}
            <button
              type="button"
              className="qrcheck"
              onClick={() => setQrOpen(true)}
              data-tutorial-pre={tutorial.isStep(5) ? 5 : undefined}
            >
              <Icon name="ic-qr" size={18} />
              QR 확인 · 입퇴장 인증
            </button>

            {/* 원칙 4의 동선 장치 — 포인트 카드보다 먼저 읽히는 자리에 포트폴리오로 가는 길을 둔다. */}
            <Link className="archlink" to="/student/archive">
              내 활동 아카이브 보기
              <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>

        {/* ---------- 포인트 (우 / 모바일 아래) ---------- */}
        <div className="pointcard">
          <div className="ptop">
            <div>
              {/* 카운트업 애니메이션 없음(원칙 1). 값은 서버의 points_balance 를 그대로 표시한다. */}
              <div className="big">
                {balance.toLocaleString()}
                <small>P</small>
              </div>
              <div className="pl">전환을 기다리는 포인트 · 1P = 1원</div>
              <div className="psub">
                누적 획득 <b>{total.toLocaleString()}P</b> · 전환된 지역화폐 <b>₩{currency.toLocaleString()}</b>
              </div>
            </div>
            <div className="coin" aria-hidden="true">
              <Icon name="ic-coin" size={26} color="var(--amber)" />
            </div>
          </div>

          {/* [전환 버튼이 없는 것이 이 화면의 결정이다 — ADR 0012]
              M월에 모은 포인트는 (M+1)월 말일에 전액 자동 전환된다. 학생은 시점도 금액도 고르지 않는다.
              그래서 여기 있는 것은 "언제 얼마가 전환된다"는 예고뿐이고, 누를 것이 없다.
              [원칙 1 가드] 진행바·D-day·"N P 더 모으면" 같은 진척 표현을 쓰지 않는다. 문장 두 줄이 전부다.
              이 자리에 게이지를 넣으려는 변경은 곧 달성률 표시다 — 스펙이 CSS 레벨까지 막아둔 것이다. */}
          <div className="settlebox">
            <div className="sb-head">
              <Icon name="ic-calendar" size={15} color="var(--brand)" />
              지역화폐 전환 예정
            </div>

            {pending === null && <div className="sb-empty">전환 일정을 확인하는 중…</div>}

            {pending !== null && pending.length === 0 && (
              <div className="sb-empty">
                아직 전환을 기다리는 포인트가 없어요.
                <br />
                활동에 참여해 모은 포인트는 다음 달 말일에 지역화폐로 전환됩니다.
              </div>
            )}

            {pending !== null &&
              pending.map((row) => {
                const v = describePending(row);
                return (
                  <div className="sb-row" key={row.month}>
                    <span className="sb-when">{v.earnedLabel}</span>
                    <span className="sb-on">{v.settleLabel}</span>
                  </div>
                );
              })}

            {/* [삭제·축약 금지] 시뮬레이션 고지(절대 원칙 3) + 학생이 앞당길 수 없다는 사실. */}
            <div className="sb-note">
              한 달 동안 모은 포인트는 <b>그 다음 달 말일</b>에 전액 지역화폐로 전환됩니다. 전환 시점과 금액은
              직접 고를 수 없어요. 이 화면의 지역화폐는 실제 결제와 연동되지 않는 시뮬레이션입니다.
            </div>
          </div>

          <PointLedger state={ledgerState} rows={ledger} />
        </div>
      </div>

      {/* [보존 — 확정 J] 화면 최하단, 카드 밖. 430px 에서도 하단 탭바에 가리지 않는다(.wrap 하단 여백). */}
      <div className="my-foot">
        <button type="button" className="my-logout" onClick={handleSignOut} disabled={signingOut}>
          <Icon name="ic-logout" size={17} />
          {signingOut ? '로그아웃 중…' : '로그아웃'}
        </button>
      </div>

      {/* QR 모달 안에서 퇴장 인증이 완료되면 서버가 포인트를 지급하고 모달이 profile 을 갱신한다.
          닫힐 때 원장을 다시 읽어야 그 적립 행이 내역에 바로 나타난다. */}
      {qrOpen && (
        <QrCenterModal
          onClose={() => {
            setQrOpen(false);
            loadLedger();
          }}
        />
      )}

      {toast && <Toast key={toast.key} message={toast.message} onDone={() => setToast(null)} />}
    </section>
  );
}
