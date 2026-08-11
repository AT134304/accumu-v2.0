// Accumu v2 — 관리자 마이페이지 (docs/specs/admin-students.md A절 / 결정 A·B·M·N·O)
// 관리자 기능 3종 중 3번("담당 학생 5명 아카이브 조회")의 진입 화면이며, 계정 정보를 함께 담는다.
//
// [원칙 6과 충돌하지 않는 이유 — 기능이 아니라 배치가 바뀐 것이다]
//   메뉴 개수 4개 그대로(홈 + 3종), 관리자가 할 수 있는 동작 0개 추가. 계정 정보는 지금까지도 셸 우측에
//   떠 있던 값(profiles_select_own)을 화면 상단으로 옮긴 것뿐이다. 새 조회·새 권한이 없다.
//
// [★ 원칙 1 가드 — 이 화면의 구조적 전제다 (결정 B)]
//   담당 학생 목록에 **숫자가 하나도 없다.** 완료 건수·포인트·지역화폐·랭킹·진척도 없음.
//   5명이 나란히 놓이는 유일한 화면이라, 숫자가 붙는 순간 그건 비교표이고 현황판이 된다.
//   바로 위 계정 카드에는 숫자 한 줄이 있지만(결정 O) **그 형식을 학생 행에 복사하지 않는다** —
//   본인이 만든 프로그램 개수는 자기 물건 세기이고, 학생 5명의 개수는 비교표다.
//
// [쓰기 동작이 0개다] 담당 학생 추가/삭제 버튼을 만들지 않는다. mentor_students 는 insert/update/delete
//   정책이 0개이고(ADR 0005 결정 7-2), 그 매핑 자체가 권한 경계다 — 앱에서 편집 가능하게 만든다는 것은
//   관리자가 자기가 볼 수 있는 학생을 스스로 늘릴 수 있게 만든다는 뜻이다.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Icon from '../components/Icon';
import { TRACK } from '../lib/taxonomy';
import { fetchMentoredStudents } from '../lib/archiveService';
import { fetchAdminPrograms } from '../lib/programService';
import { fetchMyInviteCode } from '../lib/profileService';
import PasswordChangeForm from '../components/PasswordChangeForm';
import '../styles/AdminShell.css';

export default function AdminMyPage() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();

  const [students, setStudents] = useState([]);
  const [hasActivity, setHasActivity] = useState(() => new Set());
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [programCounts, setProgramCounts] = useState(null); // { published, draft } — 실패하면 null(줄 생략)
  const [inviteCode, setInviteCode] = useState(null); // 내 학교 초대코드 — 실패하면 null(줄 생략)
  // 초대코드 유출 완화(2026-08-11, 케빈 요청) — 화면에 상시 노출되면 옆에서 보거나 화면 공유 중에
  // 새는 경로가 된다. 기본은 가려진 채로 시작한다(false) — "복사"는 가린 채로도 그대로 동작한다
  // (실제 값을 아는 사람이 스스로 쓰는 동작이지 "보여주기"가 아니라서).
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const adminId = profile?.id;

  useEffect(() => {
    let cancelled = false;

    /* [두 조회를 Promise.all 로 묶지 않는다 — 스펙 "조회 설계"]
       운영 요약 한 줄(결정 O) 때문에 담당 학생 아카이브가 안 뜨면 주객이 전도된다. */
    (async () => {
      setState('loading');
      try {
        const res = await fetchMentoredStudents();
        if (cancelled) return;
        setStudents(res.students);
        setHasActivity(res.hasActivity);
        setState('ready');
      } catch (err) {
        // 매핑 0건("아직 배정되지 않았습니다")과 조회 실패는 다른 상태다. 문구를 섞지 않는다.
        console.error('[AdminMyPage] 담당 학생 조회 실패:', err);
        if (cancelled) return;
        setStudents([]);
        setState('error');
      }
    })();

    if (!adminId) return () => { cancelled = true; };

    (async () => {
      try {
        // 결정 O — 새 서비스 함수 0개. 프로그램 관리 화면이 쓰는 조회를 그대로 재사용한다.
        const rows = await fetchAdminPrograms(adminId);
        if (cancelled) return;
        const published = rows.filter((p) => p.is_published).length;
        setProgramCounts({ published, draft: rows.length - published });
      } catch (err) {
        // 이 줄만 조용히 생략한다 — 계정 정보와 담당 학생 목록은 이것 때문에 죽지 않는다.
        console.warn('[AdminMyPage] 내가 올린 프로그램 수 조회 실패 — 요약 줄을 생략합니다:', err);
      }
    })();

    (async () => {
      try {
        // 초대코드는 "표시"다(auth-signup 확정 C) — 발급·재발급·만료 함수를 만들지 않는다.
        // 정책이 본인 school 코드 1행만 내려주므로 admin_id 필터를 클라이언트에서 걸지 않는다.
        const code = await fetchMyInviteCode();
        if (!cancelled) setInviteCode(code);
      } catch (err) {
        // 마이그레이션 미적용 프로젝트에서도 화면이 죽지 않아야 한다 — 이 줄만 생략된다.
        console.warn('[AdminMyPage] 초대코드 조회 실패 — 해당 줄을 생략합니다:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [adminId]);

  // 클립보드는 보안 컨텍스트(localhost/HTTPS)에서만 열린다. 실패해도 코드는 화면에 그대로 보이므로
  // 오류로 다루지 않고 버튼 라벨만 원래대로 둔다(불러주는 것이 원래 사용 방식이다).
  const handleCopy = useCallback(async () => {
    if (!inviteCode) return;
    try {
      await navigator.clipboard.writeText(inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      console.warn('[AdminMyPage] 클립보드 복사 실패(화면의 코드를 직접 읽어 전달하면 된다):', err);
    }
  }, [inviteCode]);

  const handleSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      // 실패해도 잠금을 풀어 다시 시도할 수 있게 한다(학생 마이페이지와 같은 패턴).
      setSigningOut(false);
    }
  }, [signOut, signingOut]);

  return (
    <section className="screen">
      {/* 학생 마이페이지와 eyebrow·제목을 문자열 단위로 맞춘다(두 역할이 같은 앱을 쓰고 있다는 신호) */}
      <div className="sec-head">
        <div>
          <div className="eyebrow">My page</div>
          <h2 className="sec">마이페이지</h2>
          <div className="sec-sub">내 계정과 담당 학생 아카이브를 확인합니다</div>
        </div>
      </div>

      {/* ---------- 계정 카드 ----------
          [읽기 전용이다] 이름·코드 수정, 비밀번호 변경, 계정 삭제 UI를 만들지 않는다 —
          profiles 는 update 정책이 0개라 만들어도 동작하지 않는다.
          [포인트·지역화폐 없음] 관리자에게는 개념 자체가 없다(CLAUDE.md 4장). */}
      <div className="adm-account">
        <div className="av" aria-hidden="true">{profile?.name?.trim()?.[0] ?? ''}</div>
        <div className="who">
          <div className="nameline">
            <h3>{profile?.name ?? ''}</h3>
            <span className="adminbadge">관리자</span>
          </div>
          <div className="code">{profile?.code ?? ''}</div>

          {/* 결정 O — 지표가 아니라 "가는 길"이다. 카드·타일·큰 숫자로 만들지 않고, 줄 전체가 링크다.
              [넣지 않는 것] 그래프·추세·전월 대비·증감 화살표, "오늘 진행 프로그램" 수(관리자 홈 담당),
              학생·참여 관련 숫자(데이터도 얻을 수 없다). */}
          {programCounts && (
            <Link className="opsline" to="/admin/programs">
              <Icon name="ic-compass" size={14} />
              내가 올린 프로그램 · 게시중 {programCounts.published} · 미게시 {programCounts.draft}
              <span className="chev" aria-hidden="true" />
            </Link>
          )}

          {/* 내 학교 초대코드 (docs/specs/auth-signup.md D / 확정 C — **표시 전용**)
              [생성·재발급·만료·회수 버튼을 만들지 않는다] 만드는 순간 관리자 기능이 4번째가 되고
              (원칙 6), 관리자가 자기 담당 학생을 늘리는 관리 도구가 된다(ADR 0005 결정 7-2).
              코드의 소유자는 시딩/마이그레이션이고 이 화면은 그것을 읽어 보여줄 뿐이다.
              [기본 가림 — ADR 0017(2026-08-11)] 화면 공유·옆에서 보기로 새는 걸 막으려고 기본은
              마스킹, 눈 아이콘으로 토글한다. 이건 UI 열화일 뿐 권한 경계가 아니다 — 진짜 경계는
              여전히 RLS(invite_codes_select_own_as_admin, 본인 것만 select)다. */}
          {inviteCode && (
            <div className="inviteline">
              <span className="k">내 학교 초대코드</span>
              {/* [기본은 가려짐] 길이는 실제 코드와 같게 유지한다 — 자릿수 자체가 힌트가 되지 않게
                  고정 길이 마스크를 쓰지 않는다(고정 길이는 "짧은 코드다/긴 코드다"를 그대로 노출한다). */}
              <b className="code">{revealed ? inviteCode : '•'.repeat(inviteCode.length)}</b>
              <button
                type="button"
                className="eyebtn"
                onClick={() => setRevealed((v) => !v)}
                aria-pressed={revealed}
                aria-label={revealed ? '초대코드 가리기' : '초대코드 보기'}
              >
                <Icon name={revealed ? 'ic-eye-off' : 'ic-eye'} size={15} />
              </button>
              <button type="button" className="copybtn" onClick={handleCopy}>
                {copied ? '복사됨' : '복사'}
              </button>
            </div>
          )}
          {inviteCode && (
            <div className="invitenote">
              학생이 회원가입 시 이 코드를 입력하면 담당 학생으로 연동됩니다.
            </div>
          )}

          {/* 비밀번호 변경 (ADR 0020) — 학생 마이페이지와 같은 컴포넌트. */}
          <PasswordChangeForm />
        </div>

        {/* 결정 N — 셸 우측 아이콘 버튼은 그대로 두고 여기에 텍스트 버튼을 하나 더 둔다(중복 허용).
            아이콘만 있는 셸 버튼은 768px 이하에서 옆의 이름·코드가 사라지며 더 모호해진다. */}
        <button type="button" className="ph-logout" onClick={handleSignOut} disabled={signingOut}>
          {signingOut ? '로그아웃 중…' : '로그아웃'}
        </button>
      </div>

      {/* ---------- 담당 학생 아카이브 ---------- */}
      <div className="sec-head" style={{ marginTop: 34 }}>
        <div>
          <h2 className="sec sm">
            <Icon name="ic-folder" size={18} color="var(--brand)" />
            담당 학생 아카이브
          </h2>
          <div className="sec-sub">학생을 선택하면 활동 기록을 볼 수 있습니다</div>
        </div>
      </div>

      {/* 시연 첫 화면이 빈 상태일 수 있다는 사실을 화면이 스스로 설명한다(이슈 3).
          가짜 참여를 시드하지 않기로 확정돼 있어(ADR 0004/0005) 이 안내가 장식이 아니다. */}
      <div className="adm-note">QR 입·퇴장 인증이 완료된 활동만 아카이브에 기록됩니다.</div>

      {state === 'loading' && <div className="empty">담당 학생을 불러오는 중…</div>}

      {state === 'error' && (
        <div className="empty">
          담당 학생을 불러오지 못했어요.
          <br />
          잠시 후 다시 시도해 주세요.
        </div>
      )}

      {state === 'ready' &&
        (students.length === 0 ? (
          <div className="empty">담당 학생이 아직 배정되지 않았습니다.</div>
        ) : (
          <div className="adm-list">
            {students.map((s) => (
              <button
                key={s.id}
                type="button"
                className="adm-row student"
                onClick={() => navigate(`/admin/mypage/students/${s.id}`)}
              >
                <span className="av sm" aria-hidden="true">{s.name?.trim()?.[0] ?? ''}</span>
                <span className="info">
                  <span className="t">{s.name}</span>
                  <span className="m">
                    {s.code}
                    {/* career_interest 가 null 인 학생이 실제로 있다(10722). 빈칸 대신 사실을 적는다. */}
                    {s.career_interest ? ` · ${TRACK[s.career_interest]?.name ?? '계열 미설정'}` : ' · 계열 미설정'}
                  </span>
                </span>
                {/* [배지는 없는 쪽에만 붙는다 — 결정 B] 있는 쪽에 붙이면 그 순간 훈장이 되고,
                    5명 목록은 성취 비교표가 된다. 건수는 세지도 않는다(Set 만 넘어온다). */}
                {!hasActivity.has(s.id) && <span className="nobadge">활동 기록 없음</span>}
                <span className="chev" aria-hidden="true" />
              </button>
            ))}
          </div>
        ))}
    </section>
  );
}
