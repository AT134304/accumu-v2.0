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
import Icon from '../components/Icon';
import Toast from '../components/Toast';
import QrCenterModal from '../components/student/QrCenterModal';
import ConvertModal from '../components/student/ConvertModal';
import PointLedger from '../components/student/PointLedger';
import { TRACK } from '../lib/taxonomy';
import { CONVERT_MIN, fetchMyPointLedger } from '../lib/pointService';
import { linkSchoolAccount, setCareerInterest } from '../lib/profileService';
import '../styles/Qr.css';
import '../styles/StudentMyPage.css';

export default function StudentMyPage() {
  // session 은 개인 계정의 이메일 표시에만 쓴다(profiles 에 email 컬럼이 없다 — auth.users 가 소유).
  const { profile, session, signOut, applyProfilePatch } = useAuth();

  const [qrOpen, setQrOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [toast, setToast] = useState(null); // { key, message }

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

  const balance = profile?.points_balance ?? 0;
  const total = profile?.points_total ?? 0;
  const currency = profile?.currency_balance ?? 0;
  // 최소 전환 단위에 못 미치면 버튼을 연다는 게 의미가 없다(기능 요구사항). 최종 판정은 서버 몫이다.
  const canConvert = balance >= CONVERT_MIN;

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

  const handleConverted = useCallback(
    async (amount) => {
      setConvertOpen(false);
      // 잔액 3종은 ConvertModal 이 RPC 응답으로 이미 갱신했다. 여기서는 원장에 생긴 '전환' 행만 다시 읽는다.
      await loadLedger();
      setToast({ key: Date.now(), message: `₩${Number(amount).toLocaleString()} 지역화폐로 전환되었습니다` });
    },
    [loadLedger]
  );

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

            {/* [보존 — 확정 J·F-1] 위치(계열 칩 아래)·카피·indigo 색 모두 프로토타입 652줄 그대로.
                신청 직후에 QR 을 발급하지 않는 규율도 그대로다(토큰 30분 만료). */}
            <button type="button" className="qrcheck" onClick={() => setQrOpen(true)}>
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
              <div className="pl">사용 가능한 포인트 · 1P = 1원</div>
              <div className="psub">
                누적 획득 <b>{total.toLocaleString()}P</b> · 전환한 지역화폐 <b>₩{currency.toLocaleString()}</b>
              </div>
            </div>
            <div className="coin" aria-hidden="true">
              <Icon name="ic-coin" size={26} color="var(--amber)" />
            </div>
          </div>

          <button
            type="button"
            className="convertbtn"
            disabled={!canConvert}
            onClick={() => setConvertOpen(true)}
          >
            <Icon name="ic-coin" size={18} />
            지역화폐로 전환
          </button>
          {/* 비활성 사유를 화면이 말한다 — 이유 없이 잠긴 버튼은 고장으로 읽힌다.
              "N P 더 모으면 전환 가능" 같은 진척 표현은 쓰지 않는다(원칙 1). */}
          {!canConvert && (
            <div className="convhint">
              전환은 {CONVERT_MIN}P부터 할 수 있어요. 프로그램에 참여해 포인트를 모아보세요.
            </div>
          )}

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

      {convertOpen && (
        <ConvertModal balance={balance} onClose={() => setConvertOpen(false)} onSuccess={handleConverted} />
      )}

      {toast && <Toast key={toast.key} message={toast.message} onDone={() => setToast(null)} />}
    </section>
  );
}
