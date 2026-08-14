// Accumu v2 — 로그인 인증 서비스 레이어
// 처리 순서·에러 메시지는 docs/adr/0002-profiles-schema-and-login-verification.md
// "로그인 검증 흐름" 표를 그대로 따른다. 역할(role) 검사가 이름(name) 검사보다 먼저 실행되어야 한다.
import { supabase } from './supabaseClient';
import { buildVirtualEmail } from './virtualEmail';

export const STUDENT_CREDENTIAL_ERROR = '학번/이름 또는 비밀번호를 확인해주세요';
export const ADMIN_CREDENTIAL_ERROR = '관리자 코드 또는 비밀번호를 확인해주세요';
export const PERSONAL_CREDENTIAL_ERROR = '이메일 또는 비밀번호를 확인해주세요';
export const ROLE_MISMATCH_ERROR = '선택한 유형과 계정이 일치하지 않습니다';

async function fetchOwnProfile(userId) {
  return supabase.from('profiles').select('*').eq('id', userId).single();
}

/** 학교 이름 비교용 정규화 — 앞뒤 공백과 연속 공백만 정리한다. 그 이상은 보정하지 않는다(loginStudent 주석). */
const normalizeSchool = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

/**
 * 학생(학교 계정) 로그인 — 학교 + 학번 + 이름 + 비밀번호 4가지 모두 일치해야 성공.
 * ADR 0002 순서:
 *   1. signInWithPassword(학번, 비밀번호)
 *   2. profiles 본인 행 조회
 *   3. role !== 'student' → signOut 후 유형 불일치 에러 (이름 검사보다 먼저)
 *   4. name 불일치 → signOut 후 자격증명 오류와 동일 문구
 *   5. school 불일치 → 같은 문구 (2026-08-14 추가)
 *
 * [school 검사 — 2026-08-14 케빈 요청]
 *   name 과 같은 성격의 대조다. 학생이 가입할 때 직접 적은 값을 로그인에서 다시 적는다.
 *   틀렸을 때 **어느 항목이 틀렸는지 말하지 않는다** — "학교는 맞고 이름이 틀렸다"고 알려주면
 *   학번 하나로 그 학생의 소속을 확인해 주는 조회 도구가 된다.
 *   [공백만 다른 것은 다른 값이 아니다] 앞뒤 공백과 연속 공백을 정리해서 비교한다. "가온 고등학교"를
 *   "가온  고등학교"로 친 것까지 틀렸다고 하는 건 대조의 목적이 아니다. 그 이상은 보정하지 않는다 —
 *   "가온고"와 "가온고등학교"는 사람 눈에도 다른 문자열이고, 여기서 같다고 우기기 시작하면
 *   어디까지 같은지의 규칙이 끝없이 늘어난다.
 *   [학교가 없는 계정] 개인 계정은 이 함수를 타지 않는다(모드가 갈린다). 학교 계정인데 school 이
 *   NULL 인 경우는 백필 이전 데이터뿐이며, 그때는 검사를 건너뛴다 — 값이 없는 것은 학생 잘못이
 *   아니고, 막으면 그 계정은 영영 로그인하지 못한다.
 */
export async function loginStudent({ studentId, name, password, school }) {
  const email = buildVirtualEmail(studentId);

  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signInData?.user) {
    throw new Error(STUDENT_CREDENTIAL_ERROR);
  }

  const { data: profile, error: profileError } = await fetchOwnProfile(signInData.user.id);

  if (profileError || !profile) {
    await supabase.auth.signOut();
    throw new Error(STUDENT_CREDENTIAL_ERROR);
  }

  if (profile.role !== 'student') {
    await supabase.auth.signOut();
    throw new Error(ROLE_MISMATCH_ERROR);
  }

  if (profile.name.trim() !== name.trim()) {
    await supabase.auth.signOut();
    throw new Error(STUDENT_CREDENTIAL_ERROR);
  }

  // 학교 대조 — 위 주석의 두 예외(값이 없는 계정 / 화면이 학교를 안 물은 경우)에서는 건너뛴다.
  if (profile.school && school && normalizeSchool(profile.school) !== normalizeSchool(school)) {
    await supabase.auth.signOut();
    throw new Error(STUDENT_CREDENTIAL_ERROR);
  }

  return profile;
}

/**
 * 관리자 로그인 — 관리자 코드 + 비밀번호 2-factor (이름 대조 없음).
 */
export async function loginAdmin({ code, password }) {
  const email = buildVirtualEmail(code);

  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signInData?.user) {
    throw new Error(ADMIN_CREDENTIAL_ERROR);
  }

  const { data: profile, error: profileError } = await fetchOwnProfile(signInData.user.id);

  if (profileError || !profile) {
    await supabase.auth.signOut();
    throw new Error(ADMIN_CREDENTIAL_ERROR);
  }

  if (profile.role !== 'admin') {
    await supabase.auth.signOut();
    throw new Error(ROLE_MISMATCH_ERROR);
  }

  return profile;
}

export async function logout() {
  await supabase.auth.signOut();
}

/* ==========================================================================
   회원가입 (docs/specs/auth-signup.md / ADR 0008)

   [★ 이 파일에서 role 을 정하지 않는다]
     signUp() 의 metadata 에 role 을 실어 보내지만 그건 *신청*일 뿐이다. 승인은 DB 트리거
     handle_new_user() 가 invite_codes 를 조회해서 한다 — 관리자 초대코드가 없으면 예외가 나고
     가입 자체가 롤백된다. 그래서 이 코드를 우회하거나 metadata 를 조작해도 관리자가 될 수 없다.
   [프로필을 여기서 만들지 않는다] profiles insert 정책이 0개다. 계정 생성과 프로필 생성이 같은
     트랜잭션이어야 유령 계정(auth 행만 있고 프로필이 없어 그 학번으로 영영 재가입 불가)이 안 생긴다.
   ========================================================================== */

/** 가입 실패 사유 → 화면 문구. 사유별로 다른 문장을 갖는 것이 이 맵의 목적이다. */
const SIGNUP_REASON_TEXT = {
  code_taken: '이미 등록된 계정입니다. 로그인해주세요.',
  invalid_code: '학번(또는 관리자 코드)을 확인해주세요.',
  invalid_school_invite: '초대코드를 확인해주세요. 담당 선생님께 받은 코드를 그대로 입력해주세요.',
  invalid_admin_invite: '관리자 초대코드가 올바르지 않습니다.',
  // [설정 문제이지 입력 문제가 아니다] Supabase 의 "Confirm email" 이 켜져 있으면 가입할 때마다
  //   확인 메일 발송을 시도하고, 가상 이메일(@accumu.local)은 받을 곳이 없는데도 발송 한도(무료 플랜
  //   시간당 2건)를 소모해 429 로 막힌다. 사용자가 입력을 고쳐서 해결할 수 있는 문제가 아니므로
  //   "다시 시도"라고만 말하지 않고 설정 문제임을 드러낸다(운영자가 곧 시연자다 — CLAUDE.md 1장).
  email_rate_limit:
    '메일 발송 한도로 가입이 일시적으로 막혔어요. Supabase 설정에서 이메일 확인(Confirm email)을 끄면 해결됩니다.',
  signup_disabled: '이 프로젝트에서 회원가입이 비활성화되어 있어요. Supabase 인증 설정을 확인해주세요.',
  email_taken: '이미 가입된 이메일입니다. 로그인해주세요.',
  invalid_email: '이메일 형식을 확인해주세요.',
};

export function signupReasonText(reason) {
  return SIGNUP_REASON_TEXT[reason] ?? '가입에 실패했어요. 잠시 후 다시 시도해 주세요.';
}

/**
 * 가입 전 사전 검증 (중복 코드 / 초대코드 유효성).
 *
 * [보안 경계가 아니다 — UX 계층이다] 우회하면 트리거와 profiles.code unique 가 최종 판정한다.
 *   여기서 먼저 거르는 이유는 트리거 예외가 "Database error saving new user" 같은 문구로 올라와
 *   사용자에게 그대로 보여줄 수 없기 때문이다(ADR 0008 결정 4).
 */
export async function checkSignupAvailability({ role, code, invite }) {
  const { data, error } = await supabase.rpc('check_signup_availability', {
    p_role: role,
    p_code: code,
    p_invite: invite || null,
  });
  if (error) throw error;
  return data ?? { ok: false, reason: 'unknown' };
}

/**
 * 공통 가입 처리. 성공하면 세션이 생기고(AuthContext 가 이어받는다) 프로필이 함께 만들어져 있다.
 *
 * @returns {Promise<{ok:true, session:boolean} | {ok:false, reason:string}>}
 *   session=false 는 "가입은 됐는데 세션이 없다" = Supabase 의 Confirm email 설정이 켜진 경우다.
 *   가상 이메일이라 확인 메일을 받을 수 없으므로 화면은 로그인 화면으로 안내한다.
 */
async function signUpWithProfile({ role, code, name, password, invite, careerInterest, school }) {
  const pre = await checkSignupAvailability({ role, code, invite });
  if (!pre.ok) return { ok: false, reason: pre.reason };

  const { data, error } = await supabase.auth.signUp({
    email: buildVirtualEmail(code),
    password,
    options: {
      // 트리거가 읽는 값. role 은 신청이고 invite 가 그 신청의 근거다(위 주석 참고).
      // [school 은 관리자 가입에서만 의미가 있다 — 2026-08-14] 학생이 보내도 트리거가 무시한다:
      //   학생의 학교는 담당 관리자에게서 상속되는 것이 유일한 경로다(20260814160000).
      data: {
        role,
        code: code.trim(),
        name: name.trim(),
        invite: invite ? invite.trim() : null,
        career_interest: careerInterest || null,
        school: school ? school.trim() : null,
      },
    },
  });

  if (error) {
    console.error('[authService] 회원가입 실패:', error);
    const message = error.message ?? '';
    // 트리거가 던진 사유는 message 로 올라온다. 초대코드 문제면 그 문장을 그대로 쓴다.
    if (/초대코드/.test(message)) {
      return { ok: false, reason: role === 'admin' ? 'invalid_admin_invite' : 'invalid_school_invite' };
    }
    if (/already registered|User already/i.test(message)) {
      return { ok: false, reason: 'code_taken' };
    }
    // 프로젝트 설정 문제 2종 — 입력을 고쳐도 해결되지 않으므로 사유를 구분해 올린다.
    if (error.code === 'over_email_send_rate_limit' || /email rate limit/i.test(message)) {
      return { ok: false, reason: 'email_rate_limit' };
    }
    if (error.code === 'signup_disabled' || /signups not allowed/i.test(message)) {
      return { ok: false, reason: 'signup_disabled' };
    }
    return { ok: false, reason: 'unknown' };
  }

  return { ok: true, session: Boolean(data?.session) };
}

/**
 * 학생 가입. invite 가 없으면 개인 계정, 있으면 그 코드의 관리자와 연동된 학교 계정이 된다.
 *
 * [school — 2026-08-14] 학교 계정일 때만 의미가 있고 그때는 **필수**다(로그인 4번째 대조 항목).
 *   개인 계정 경로에서는 트리거가 무시하고 NULL 로 둔다 — 소속이 없는 계정이라서다.
 *   >>> 초대코드 주인(관리자)의 학교와 같을 필요가 없다. 학생이 적은 값이 그 학생의 학교다.
 */
export async function signUpStudent({ studentId, name, password, invite, careerInterest, school }) {
  return signUpWithProfile({
    role: 'student',
    code: studentId,
    name,
    password,
    invite,
    careerInterest,
    school,
  });
}

/**
 * 관리자 가입. 관리자 초대코드가 필수이며, 틀리면 학생으로 대신 만들어주지 않는다(fail-closed).
 *
 * [school 이 필수다 — 2026-08-14] 관리자는 학교의 주인이다. 이 값이 담당 학생 전원에게 상속되고
 *   로그인 화면의 학교 목록이 되므로, 비어 있으면 트리거가 가입 자체를 거부한다(22023).
 */
export async function signUpAdmin({ code, name, password, invite, school }) {
  return signUpWithProfile({ role: 'admin', code, name, password, invite, school });
}

// [fetchSchoolNames() 는 삭제됐다 — 2026-08-14]
//   로그인 화면이 드롭다운 대신 직접 입력을 쓰게 되면서 호출자가 0개가 됐고, 학교가 관리자와
//   무관해지면서 그 목록은 부분 목록이 됐다("내 학교가 목록에 없다"가 정상 상황이 된다).
//   서버 함수 school_names() 도 20260814180000 이 drop 한다.
//   >>> 목록 조회를 되살리려면 그 전에 "학교라는 값의 주인이 누구인가"부터 다시 정할 것.

/* ==========================================================================
   개인 계정 — 학번이 없다 (docs/specs/auth-signup.md 개정 2026-07-31)

   [왜 학번을 받지 않는가] 개인 계정은 학교에 소속되지 않는다. 학번은 학교가 부여하는 식별자이므로
     받을 근거가 없고, 받으면 "아무 숫자나 학번처럼 입력된 값"이 unique 공간을 차지한다.
   [그럼 profiles.code 는] 서버가 'P-XXXXXX' 로 발급한다(generate_personal_code). 사람이 입력하거나
     외우는 값이 아니며, 로그인 아이디는 이메일(또는 소셜 계정)이다.
   ========================================================================== */

/**
 * 개인 계정 가입 (이메일 + 비밀번호). 학번·초대코드를 보내지 않는다 = 트리거가 개인 계정으로 만든다.
 *
 * [중복 이메일 판정] Supabase 는 계정 열거를 막으려고 이미 가입된 이메일에도 성공처럼 응답한다.
 *   그때 user.identities 가 빈 배열로 온다 — 그것이 유일한 신호다(문서화된 동작).
 */
export async function signUpPersonal({ email, password, name, careerInterest }) {
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      // code 를 싣지 않는다. 트리거가 그걸 보고 "학번 없는 개인 계정"으로 판정한다.
      data: { name: name.trim(), career_interest: careerInterest || null },
    },
  });

  if (error) {
    console.error('[authService] 개인 계정 가입 실패:', error);
    const message = error.message ?? '';
    if (error.code === 'over_email_send_rate_limit' || /email rate limit/i.test(message)) {
      return { ok: false, reason: 'email_rate_limit' };
    }
    if (error.code === 'signup_disabled' || /signups not allowed/i.test(message)) {
      return { ok: false, reason: 'signup_disabled' };
    }
    if (/already registered|User already/i.test(message)) return { ok: false, reason: 'email_taken' };
    if (/invalid.*email/i.test(message)) return { ok: false, reason: 'invalid_email' };
    return { ok: false, reason: 'unknown' };
  }

  if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return { ok: false, reason: 'email_taken' };
  }

  return { ok: true, session: Boolean(data?.session) };
}

/**
 * 개인 계정 로그인 (이메일 + 비밀번호).
 * 학교 계정의 loginStudent 와 달리 이름 대조가 없다 — 이메일 자체가 고유 식별자라 3-factor 가 성립하지 않는다.
 * role 검사는 그대로 한다(관리자 계정으로 이 폼에 들어오는 경로를 막는다).
 */
export async function loginPersonal({ email, password }) {
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (signInError || !signInData?.user) {
    throw new Error(PERSONAL_CREDENTIAL_ERROR);
  }

  const { data: profile, error: profileError } = await fetchOwnProfile(signInData.user.id);
  if (profileError || !profile) {
    await supabase.auth.signOut();
    throw new Error(PERSONAL_CREDENTIAL_ERROR);
  }
  if (profile.role !== 'student') {
    await supabase.auth.signOut();
    throw new Error(ROLE_MISMATCH_ERROR);
  }
  return profile;
}

/* ==========================================================================
   네이버 로그인 (docs/adr/0009-naver-login-via-edge-function.md)

   [Supabase 의 소셜 경로를 쓰지 않는다] 네이버는 Supabase 제공자 목록에 없고 OIDC id_token 도
     발급하지 않아 signInWithOAuth / signInWithIdToken 어느 쪽으로도 붙지 않는다. 그래서
     code -> token -> 프로필 -> 계정 -> 세션을 Edge Function(naver-auth)이 직접 잇는다.

   [★ 네이버로는 관리자가 될 수 없다] Edge Function 이 계정을 만들 때 metadata 에 name 만 넣는다.
     그러면 handle_new_user() 트리거의 "(c) 개인 이메일 가입" 분기를 타 학생 · 개인 계정으로 고정된다.
     이 파일이 role 이나 초대코드를 보낼 자리는 존재하지 않는다.

   [가입/로그인 구분이 없다] 첫 방문이면 계정이 생기고 아니면 로그인된다. 두 화면이 같은 버튼을 쓴다.
   ========================================================================== */

const NAVER_STATE_KEY = 'accumu:naver_state';

/** 네이버 로그인이 설정돼 있는가(클라이언트 ID 주입 여부). 버튼을 그릴지 판단하는 데 쓴다. */
export function isNaverConfigured() {
  return Boolean(import.meta.env.VITE_NAVER_CLIENT_ID);
}

/**
 * 네이버 인증 화면으로 이동한다.
 *
 * [state 는 CSRF 방어다] 여기서 만들어 sessionStorage 에 넣고, 돌아왔을 때 대조한다. 대조에 실패하면
 *   code 를 교환하지 않는다 — 남이 심어둔 code 로 남의 계정에 로그인되는 경로를 막는다.
 * [redirect_uri 는 앱 주소다] 구글·카카오와 달리 네이버는 Supabase 콜백이 아니라 우리 앱으로 직접
 *   돌아온다. 그래서 네이버 개발자센터에 등록하는 Callback URL 이 곧 이 값이다.
 */
export function startNaverLogin() {
  const clientId = import.meta.env.VITE_NAVER_CLIENT_ID;
  if (!clientId) throw new Error('NAVER_NOT_CONFIGURED');

  const state = crypto.randomUUID();
  sessionStorage.setItem(NAVER_STATE_KEY, state);

  const redirectUri = `${window.location.origin}/auth/naver`;
  window.location.href =
    'https://nid.naver.com/oauth2.0/authorize?response_type=code' +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;
}

/** 네이버 로그인 실패 사유 → 화면 문구. 설정 문제와 사용자 문제를 섞지 않는다. */
const NAVER_REASON_TEXT = {
  state_mismatch: '로그인 요청이 만료됐어요. 처음부터 다시 시도해 주세요.',
  denied: '네이버 로그인을 취소했어요.',
  not_configured: '네이버 로그인이 아직 설정되지 않았어요. (naver-auth 함수의 키를 확인해주세요)',
  token_exchange_failed: '네이버 인증에 실패했어요. 잠시 후 다시 시도해 주세요.',
  profile_failed: '네이버 프로필을 가져오지 못했어요. 제공 동의 항목을 확인해주세요.',
  create_failed: '계정을 만들지 못했어요. 잠시 후 다시 시도해 주세요.',
  session_failed: '로그인 세션을 만들지 못했어요. 잠시 후 다시 시도해 주세요.',
  function_missing: '네이버 로그인 함수(naver-auth)가 배포되지 않았어요.',
};

export function naverReasonText(reason) {
  return NAVER_REASON_TEXT[reason] ?? '네이버 로그인에 실패했어요. 잠시 후 다시 시도해 주세요.';
}

/**
 * 네이버가 돌려준 code 를 세션으로 바꾼다. /auth/naver 콜백 화면이 호출한다.
 *
 * [code 는 1회용이다] 두 번 교환하면 실패한다 — 호출부는 StrictMode 이중 실행을 ref 로 막아야 한다.
 * [세션은 verifyOtp 로 만든다] Edge Function 이 발급한 매직링크 token_hash 를 교환한다.
 *   Admin API 로는 access_token 을 직접 만들 수 없어서 택한 경로다(ADR 0009 결정 2).
 */
export async function completeNaverLogin({ code, state }) {
  const saved = sessionStorage.getItem(NAVER_STATE_KEY);
  sessionStorage.removeItem(NAVER_STATE_KEY);
  if (!saved || saved !== state) return { ok: false, reason: 'state_mismatch' };

  const { data, error } = await supabase.functions.invoke('naver-auth', { body: { code, state } });

  if (error) {
    console.error('[authService] naver-auth 호출 실패:', error);
    // 함수가 아직 배포되지 않은 경우와 함수 내부 실패를 구분해준다.
    const status = error.context?.status;
    if (status === 404) return { ok: false, reason: 'function_missing' };
    return { ok: false, reason: 'unknown' };
  }
  if (!data?.token_hash) return { ok: false, reason: data?.error ?? 'unknown' };

  const { error: otpError } = await supabase.auth.verifyOtp({
    token_hash: data.token_hash,
    type: 'magiclink',
  });
  if (otpError) {
    console.error('[authService] 세션 교환 실패:', otpError);
    return { ok: false, reason: 'session_failed' };
  }

  return { ok: true };
}

/* ==========================================================================
   구글 로그인 — Edge Function 직접 교환 (ADR 0011)

   [ADR 0010 의 번복] 처음에는 Supabase 기본 제공자(signInWithOAuth)로 붙였다. 케빈 결정으로
     **네이버와 같은 방식**으로 바꿨다. 이유는 기능이 아니라 운영이다 — 제공자마다 고장났을 때
     볼 곳이 다르면(한쪽은 함수 로그, 한쪽은 대시보드 토글) 시연 중에 원인을 못 찾는다.
     아래 코드가 네이버 블록과 거의 같은 모양인 것은 의도된 것이다.

   [★ 구글로도 관리자가 될 수 없다] Edge Function 이 계정을 만들 때 metadata 에 name 만 넣는다.
     그러면 handle_new_user() 트리거의 "(c) 개인 이메일 가입" 분기를 타 학생 · 개인 계정으로 고정된다.
     이 파일이 role 이나 초대코드를 보낼 자리는 존재하지 않는다.

   [가입/로그인 구분이 없다] 첫 방문이면 계정이 생기고 아니면 로그인된다. 두 화면이 같은 버튼을 쓴다.
   ========================================================================== */

const GOOGLE_STATE_KEY = 'accumu:google_state';

/** 구글 로그인이 설정돼 있는가(클라이언트 ID 주입 여부). 버튼을 그릴지 판단하는 데 쓴다. */
export function isGoogleConfigured() {
  return Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID);
}

/**
 * 구글 인증 화면으로 이동한다.
 *
 * [state 는 CSRF 방어다] 네이버와 같은 규율 — 여기서 만들어 sessionStorage 에 넣고 돌아왔을 때
 *   대조한다. 대조 실패면 code 를 교환하지 않는다. Supabase 경로를 버린 대가로 우리가 진다.
 * [redirect_uri 는 앱 주소다] Supabase 콜백이 아니라 우리 앱으로 직접 돌아온다. 그래서 Google Cloud
 *   Console 에 등록하는 승인된 리디렉션 URI 가 곧 이 값이다(네이버와 같은 형태가 됐다).
 * [scope] openid·email·profile 셋뿐이다. 그 이상은 요구하지 않는다 — 계정 식별에 필요한 최소값이다.
 */
export function startGoogleLogin() {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('GOOGLE_NOT_CONFIGURED');

  const state = crypto.randomUUID();
  sessionStorage.setItem(GOOGLE_STATE_KEY, state);

  const redirectUri = `${window.location.origin}/auth/google`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: 'openid email profile',
    // 계정 선택 화면을 항상 띄운다 — 1인 시연에서 계정을 바꿔가며 보여줘야 하는데,
    // 이게 없으면 이전에 고른 계정으로 조용히 로그인돼 "안 바뀐다"로 읽힌다.
    prompt: 'select_account',
  });

  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** 구글 로그인 실패 사유 → 화면 문구. 설정 문제와 사용자 문제를 섞지 않는다. */
const GOOGLE_REASON_TEXT = {
  state_mismatch: '로그인 요청이 만료됐어요. 처음부터 다시 시도해 주세요.',
  denied: '구글 로그인을 취소했어요.',
  not_configured: '구글 로그인이 아직 설정되지 않았어요. (google-auth 함수의 키를 확인해주세요)',
  token_exchange_failed: '구글 인증에 실패했어요. 잠시 후 다시 시도해 주세요.',
  profile_failed: '구글 프로필을 가져오지 못했어요. 동의 항목을 확인해주세요.',
  create_failed: '계정을 만들지 못했어요. 잠시 후 다시 시도해 주세요.',
  session_failed: '로그인 세션을 만들지 못했어요. 잠시 후 다시 시도해 주세요.',
  function_missing: '구글 로그인 함수(google-auth)가 배포되지 않았어요.',
};

export function googleReasonText(reason) {
  return GOOGLE_REASON_TEXT[reason] ?? '구글 로그인에 실패했어요. 잠시 후 다시 시도해 주세요.';
}

/**
 * 구글이 돌려준 code 를 세션으로 바꾼다. /auth/google 콜백 화면이 호출한다.
 *
 * [code 는 1회용이다] 두 번 교환하면 실패한다 — 호출부는 StrictMode 이중 실행을 ref 로 막아야 한다.
 * [세션은 verifyOtp 로 만든다] Edge Function 이 발급한 매직링크 token_hash 를 교환한다.
 *   Admin API 로는 access_token 을 직접 만들 수 없어서 택한 경로다(네이버와 같다).
 */
export async function completeGoogleLogin({ code, state }) {
  const saved = sessionStorage.getItem(GOOGLE_STATE_KEY);
  sessionStorage.removeItem(GOOGLE_STATE_KEY);
  if (!saved || saved !== state) return { ok: false, reason: 'state_mismatch' };

  const { data, error } = await supabase.functions.invoke('google-auth', { body: { code, state } });

  if (error) {
    console.error('[authService] google-auth 호출 실패:', error);
    // 함수가 아직 배포되지 않은 경우와 함수 내부 실패를 구분해준다.
    const status = error.context?.status;
    if (status === 404) return { ok: false, reason: 'function_missing' };
    return { ok: false, reason: 'unknown' };
  }
  if (!data?.token_hash) return { ok: false, reason: data?.error ?? 'unknown' };

  const { error: otpError } = await supabase.auth.verifyOtp({
    token_hash: data.token_hash,
    type: 'magiclink',
  });
  if (otpError) {
    console.error('[authService] 세션 교환 실패:', otpError);
    return { ok: false, reason: 'session_failed' };
  }

  return { ok: true };
}

/* ==========================================================================
   비밀번호 변경/재설정 (ADR 0020)
   ========================================================================== */

/**
 * 세션만으로 비밀번호를 덮어쓴다 — **옛 비밀번호를 모르는 경로 전용.**
 *
 * [현재 비밀번호를 묻지 않는 것이 여기서는 맞다] 이 함수를 쓰는 곳은 두 군데이고 둘 다 "옛
 *   비밀번호를 알 수 없는" 상황이다:
 *     1. /auth/reset-password — 이메일 재설정 링크로 들어온 recovery 세션 (ADR 0020)
 *     2. (서버) admin-reset-student-password — 관리자 초기화 (ADR 0019)
 *   비밀번호를 잊어버려서 온 사람에게 옛 비밀번호를 물으면 그 경로 자체가 성립하지 않는다.
 *
 * >>> **마이페이지의 "비밀번호 변경"은 이 함수를 쓰지 않는다.** 2026-08-14부터
 *     changeMyPasswordWithCurrent() 로 옮겼다 — 아래 그 함수의 주석에 이유가 있다.
 *     여기로 되돌리지 말 것: 로그인된 화면을 잠깐 만진 사람이 계정을 통째로 가져가는 경로가 열린다.
 *
 * @param {string} newPassword
 * @throws Supabase Auth 에러(세션 없음 등) 그대로.
 */
export async function updateMyPassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export const CURRENT_PASSWORD_ERROR = '현재 비밀번호가 올바르지 않아요.';
export const PASSWORD_RATE_LIMIT_ERROR = '시도가 너무 잦아요. 잠시 후 다시 시도해 주세요.';

/**
 * 마이페이지의 비밀번호 변경 — **현재 비밀번호를 확인한 뒤** 새 비밀번호로 바꾼다 (2026-08-14).
 *
 * [왜 세션만으로는 부족한가] "로그인된 세션 = 본인"이라는 전제는 *계정 주인 확인*에는 맞지만,
 *   이 확인이 진짜로 막는 위협은 그게 아니다 — **로그인된 화면을 잠깐 만진 사람이 계정을 영구히
 *   가져가는 것**이다. 학교 공용 PC에 로그아웃하지 않고 자리를 뜨거나, 폰을 잠깐 빌려주거나,
 *   토큰이 새는 경우. 현재 비밀번호를 모르면 그 사람은 비밀번호를 바꿀 수 없고, 원래 주인은
 *   계정을 잃지 않는다. 이 앱은 **학번이 로그인 아이디**라 아이디 쪽은 이미 반쯤 공개돼 있어서
 *   이 장벽이 더 중요하다. (표준 관행이기도 하다 — OWASP ASVS가 명시적으로 요구한다.)
 *
 * [확인 방법 = 같은 이메일로 다시 로그인] Supabase는 "현재 비밀번호 검증" API를 따로 주지 않는다.
 *   reauthenticate()는 확인 코드를 **메일로 보내는** 방식이라 학번/관리자코드 계정(@accumu.local
 *   가상 주소)에서는 쓸 수 없다. 그래서 세션의 이메일로 signInWithPassword를 한 번 더 한다.
 *   - 실패해도 기존 세션은 그대로 남는다(로그아웃되지 않는다).
 *   - 성공하면 같은 사용자의 세션이 새로 발급되며 교체된다. AuthContext의 onAuthStateChange는
 *     `profileIdRef.current === userId`면 프로필을 다시 읽지 않으므로 화면이 흔들리지 않는다.
 *   - 세션의 이메일을 쓰므로 학번(20250001@accumu.local)·관리자코드·실제 이메일이 모두 같은 경로다.
 *
 * >>> 소셜 계정(네이버/구글)에는 애초에 비밀번호가 없어 이 함수가 성립하지 않는다.
 *     화면에서 진입 자체를 막는다(PasswordChangeForm의 socialProviderOf 분기).
 *
 * @param {string} currentPassword
 * @param {string} newPassword
 * @throws {Error} CURRENT_PASSWORD_ERROR / PASSWORD_RATE_LIMIT_ERROR 또는 Supabase 에러
 */
export async function changeMyPasswordWithCurrent(currentPassword, newPassword) {
  const { data } = await supabase.auth.getSession();
  const email = data?.session?.user?.email;
  if (!email) throw new Error('로그인 정보를 확인할 수 없어요. 다시 로그인해 주세요.');

  const { error: verifyError } = await supabase.auth.signInWithPassword({
    email,
    password: currentPassword,
  });
  if (verifyError) {
    // 429는 "틀렸다"가 아니라 "너무 자주 시도했다"이다 — 같은 문구로 뭉개면 맞는 비밀번호를 넣고도
    // 계속 틀렸다는 말을 듣게 된다.
    if (verifyError.status === 429) throw new Error(PASSWORD_RATE_LIMIT_ERROR);
    throw new Error(CURRENT_PASSWORD_ERROR);
  }

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

/**
 * 소셜 로그인으로 만들어진 계정인지 — 맞으면 'naver' | 'google', 아니면 null.
 *
 * [provider 로는 알 수 없다] 두 Edge Function 이 admin.createUser 로 계정을 만들기 때문에
 *   Supabase 가 보는 provider 는 'email' 이다. 게다가 제공자가 준 **실제 이메일**을 그대로 쓰므로
 *   (naver-auth 96줄 / google-auth 117줄) 이메일 모양으로도 개인 계정과 구분되지 않는다.
 *   그래서 두 함수가 user_metadata.auth_provider 를 직접 심는다 — 그 값을 읽는 곳이 여기다.
 * [값이 없으면 null 로 본다] 표식을 심기 전에 만들어진 소셜 계정은 다음 로그인 때 채워진다.
 *   그전까지는 비밀번호 변경 칸이 보이지만, 현재 비밀번호를 모르니 바꾸지는 못한다(안전한 쪽).
 */
export function socialProviderOf(user) {
  const p = user?.user_metadata?.auth_provider;
  return p === 'naver' || p === 'google' ? p : null;
}

/**
 * 개인 계정(실제 이메일) 비밀번호 재설정 이메일 발송.
 *
 * [학교/관리자 계정에는 쓰지 않는다] `{학번}@accumu.local` 같은 가상 이메일은 받는 사람이 없어
 *   이 방법이 원천적으로 통하지 않는다(ADR 0019 배경) — 그쪽은 관리자의 "비밀번호 초기화"(학생) 또는
 *   운영자 문의(관리자 본인) 경로를 대신 쓴다. 이 함수를 학교/관리자 이메일에 호출하지 말 것.
 * [존재 여부를 노출하지 않는다] Supabase는 이메일이 실제로 등록돼 있는지와 무관하게 항상 같은 결과를
 *   돌려준다 — 호출부도 "보냈어요"라고만 말하고 성공/실패로 계정 존재 여부를 유추할 문구를 만들지 말 것.
 *
 * @param {string} email
 * @throws 네트워크 등 진짜 예외만 던진다.
 */
export async function requestPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/auth/reset-password`,
  });
  if (error) throw error;
}

/**
 * 이름으로 학번 찾기 — 학교 계정 전용(ADR 0020).
 *
 * [학번 노출을 수용하는 이유 — ADR 0008 결정 4의 연장] "학번은 교실에서 공개적으로 쓰이는 식별자이고
 *   비밀번호 없이는 아무것도 되지 않는다"는 판단을 이 기능에도 그대로 적용한다. check_signup_availability
 *   가 이미 같은 이유로 "code_taken"(학번 존재 여부)을 노출해 왔다 — 여기서 이름→학번 조회를 여는 것은
 *   그 판단을 넓힌 것이지 새로 만든 것이 아니다.
 * [정확히 일치하는 이름만, 동명이인은 알려주지 않는다] 서버(find_student_code_by_name RPC)가 그 학번을
 *   추측해 알려주지 않는다 — "동명이인이 있어요"까지만 말한다.
 *
 * @param {string} name
 * @returns {Promise<{ok:true, code:string} | {ok:false, reason:'not_found'|'ambiguous'}>}
 * @throws 네트워크 등 진짜 예외만 던진다.
 */
export async function findStudentCodeByName(name) {
  const { data, error } = await supabase.rpc('find_student_code_by_name', { p_name: name });
  if (error) throw error;
  return data ?? { ok: false, reason: 'not_found' };
}
